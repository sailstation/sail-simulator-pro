// Testes do envio de e-mail (ADR-0005) contra um servidor SMTP falso em processo.
// Os caminhos com TLS (STARTTLS e porta 465) não são exercidos aqui — exigiriam certificado;
// ficam para validação com o SMTP real da cooperativa (registrado no ADR).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { buildMessage, createMailer } from "./mail.mjs";

// Servidor SMTP mínimo: EHLO, AUTH LOGIN, MAIL, RCPT, DATA (com desdot-stuffing) e QUIT.
function fakeSmtp({ failOn = null } = {}) {
  const state = { messages: [], envelope: [], auth: [] };
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "", current = null, dataMode = false, authStep = 0;
    const say = line => socket.write(line + "\r\n");
    say("220 fake ESMTP");
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (dataMode) {
          if (line === ".") { state.messages.push(current); current = null; dataMode = false; say("250 2.0.0 ok"); }
          else current = (current === null ? "" : current + "\r\n") + line.replace(/^\.\./, ".");
          continue;
        }
        if (authStep === 1) { state.auth.push(Buffer.from(line, "base64").toString()); authStep = 2; say("334 UGFzc3dvcmQ6"); continue; }
        if (authStep === 2) { state.auth.push(Buffer.from(line, "base64").toString()); authStep = 0; say("235 2.7.0 autenticado"); continue; }
        const verb = line.split(" ")[0].toUpperCase();
        if (failOn === verb) { say("550 5.7.1 recusado pelo teste"); continue; }
        if (verb === "EHLO") say("250-fake\r\n250 AUTH LOGIN");
        else if (verb === "AUTH") { authStep = 1; say("334 VXNlcm5hbWU6"); }
        else if (verb === "MAIL" || verb === "RCPT") { state.envelope.push(line); say("250 2.1.0 ok"); }
        else if (verb === "DATA") { dataMode = true; current = null; say("354 fim com <CRLF>.<CRLF>"); }
        else if (verb === "QUIT") say("221 2.0.0 tchau");
        else say("250 ok");
      }
    });
  });
  return { server, state };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

const mail = { to: "Velejadora <ana@exemplo.com>", subject: "Confirme seu e-mail — Sail ⛵", text: "Linha 1\n.inicia com ponto\nLinha 3" };

test("envia com AUTH LOGIN: envelope, assunto codificado, base64 e desdot-stuffing", async () => {
  const { server, state } = fakeSmtp();
  const port = await listen(server);
  const mailer = createMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_TLS: "off",
    SMTP_USER: "sail", SMTP_PASS: "segredo", SMTP_FROM: "Sail <no-reply@sailstation.com>" }, () => {});
  await mailer.send(mail);
  server.close();
  assert.deepEqual(state.auth, ["sail", "segredo"]);
  assert.deepEqual(state.envelope, ["MAIL FROM:<no-reply@sailstation.com>", "RCPT TO:<ana@exemplo.com>"]);
  const [message] = state.messages;
  assert.match(message, /^From: Sail <no-reply@sailstation\.com>\r\n/);
  assert.match(message, /To: Velejadora <ana@exemplo\.com>/);
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  assert.match(message, /Content-Type: text\/plain; charset=utf-8/);
  const body = message.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.equal(Buffer.from(body, "base64").toString(), mail.text, "corpo preservado, inclusive linha com ponto");
});

test("remetente cai para SMTP_USER quando SMTP_FROM falta; sem usuário não há AUTH", async () => {
  const { server, state } = fakeSmtp();
  const port = await listen(server);
  const comUsuario = createMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_TLS: "off", SMTP_USER: "conta@exemplo.com" }, () => {});
  await comUsuario.send({ ...mail, to: "b@exemplo.com" });
  assert.deepEqual(state.auth, ["conta@exemplo.com", ""], "AUTH LOGIN com senha vazia");
  assert.equal(state.envelope[0], "MAIL FROM:<conta@exemplo.com>");
  const semUsuario = createMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_TLS: "off", SMTP_FROM: "no-reply@exemplo.com" }, () => {});
  await semUsuario.send({ ...mail, to: "c@exemplo.com" });
  server.close();
  assert.deepEqual(state.auth, ["conta@exemplo.com", ""], "sem usuário, nenhum AUTH novo");
  assert.equal(state.envelope[2], "MAIL FROM:<no-reply@exemplo.com>");
});

test("recusa do servidor vira erro com o código SMTP", async () => {
  const { server } = fakeSmtp({ failOn: "RCPT" });
  const port = await listen(server);
  const mailer = createMailer({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_TLS: "off", SMTP_FROM: "a@b.com" }, () => {});
  await assert.rejects(mailer.send({ ...mail, to: "c@d.com" }), /550/);
  server.close();
});

test("sem SMTP_HOST o e-mail vai para o log em vez de falhar", async () => {
  const logged = [];
  const mailer = createMailer({}, line => logged.push(line));
  assert.equal(mailer.dev, true);
  await mailer.send({ to: "a@b.com", subject: "Oi", text: "corpo" });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /para=a@b\.com/);
  assert.match(logged[0], /assunto=Oi/);
  assert.match(logged[0], /corpo/);
});

test("cabeçalhos com CRLF são rejeitados (injeção de cabeçalho)", () => {
  assert.throws(() => buildMessage({ from: "a@b.com", to: "c@d.com", subject: "Oi\r\nBcc: x@y.com", text: "t" }), /Subject/);
  assert.throws(() => buildMessage({ from: "a@b.com\nX: 1", to: "c@d.com", subject: "Oi", text: "t" }), /From/);
  assert.throws(() => buildMessage({ from: "a@b.com", to: "", subject: "Oi", text: "t" }), /To/);
});

test("assunto e corpo acentuados saem codificados", () => {
  const message = buildMessage({ from: "a@b.com", to: "c@d.com", subject: "Confirmação", text: "até amanhã" });
  const subject = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(message)[1];
  assert.equal(Buffer.from(subject, "base64").toString(), "Confirmação");
  for (const line of message.split("\r\n")) assert.ok(line.length <= 998, "linhas dentro do limite SMTP");
});
