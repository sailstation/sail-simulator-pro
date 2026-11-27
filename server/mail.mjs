// Envio de e-mail do backend (ADR-0005): cliente SMTP mínimo em Node puro
// (EHLO, STARTTLS ou TLS implícito, AUTH LOGIN, um destinatário, texto puro),
// sem dependência nova. Configuração somente por ambiente:
// SMTP_HOST, SMTP_PORT (padrão 587; 465 = TLS implícito), SMTP_USER, SMTP_PASS, SMTP_FROM.
// SMTP_TLS=off desliga o STARTTLS (relay local). Sem SMTP_HOST, o e-mail vai para o log
// (modo desenvolvimento) em vez de falhar.
import net from "node:net";
import tls from "node:tls";

const TIMEOUT_MS = 15_000;
const HELO = "sail-simulator-pro";

function header(value, name) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error(`Cabeçalho de e-mail inválido: ${name}`);
  return value.trim();
}

// Endereço puro do envelope a partir de "Nome <endereco@dominio>" ou "endereco@dominio".
const bareAddress = value => (/<([^<>\s]+)>/.exec(value)?.[1]) ?? value;

// Mensagem RFC 5322 mínima: assunto codificado (RFC 2047) e corpo em base64, só texto.
export function buildMessage({ from, to, subject, text }) {
  const body = Buffer.from(String(text), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
  return [
    `From: ${header(from, "From")}`,
    `To: ${header(to, "To")}`,
    `Subject: =?UTF-8?B?${Buffer.from(header(subject, "Subject"), "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body
  ].join("\r\n");
}

// Leitor de respostas SMTP: junta linhas "250-..." até a linha final "250 ...".
function createReader(socket) {
  let buffer = "", lines = "", ready = null, waiter = null, failure = null;
  const deliver = () => {
    if (ready && waiter) { const { resolve } = waiter; waiter = null; const reply = ready; ready = null; resolve(reply); }
  };
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      lines += (lines ? "\n" : "") + line;
      if (/^\d{3} /.test(line)) { ready = { code: Number(line.slice(0, 3)), text: lines }; lines = ""; deliver(); }
    }
  });
  const fail = error => { failure = error; if (waiter) { const { reject } = waiter; waiter = null; reject(error); } };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Conexão SMTP encerrada pelo servidor.")));
  return () => {
    if (failure) return Promise.reject(failure);
    if (ready) { const reply = ready; ready = null; return Promise.resolve(reply); }
    return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
  };
}

async function smtpSend(config, { to, subject, text }) {
  const message = buildMessage({ from: config.from, to, subject, text });
  let socket = config.port === 465
    ? tls.connect({ host: config.host, port: config.port, servername: config.host })
    : net.connect({ host: config.host, port: config.port });
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error("Tempo esgotado no envio do e-mail.")));
  let next = createReader(socket);
  const command = async (line, codes) => {
    if (line !== null) socket.write(line + "\r\n");
    const reply = await next();
    if (!codes.includes(reply.code)) throw new Error(`SMTP recusou (${reply.code}): ${reply.text}`);
    return reply;
  };
  try {
    await command(null, [220]);
    await command(`EHLO ${HELO}`, [250]);
    if (config.port !== 465 && config.tls) {
      await command("STARTTLS", [220]);
      socket = await new Promise((resolve, reject) => {
        const secure = tls.connect({ socket, servername: config.host }, () => resolve(secure));
        secure.once("error", reject);
      });
      socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error("Tempo esgotado no envio do e-mail.")));
      next = createReader(socket);
      await command(`EHLO ${HELO}`, [250]);
    }
    if (config.user) {
      await command("AUTH LOGIN", [334]);
      await command(Buffer.from(config.user, "utf8").toString("base64"), [334]);
      await command(Buffer.from(config.pass ?? "", "utf8").toString("base64"), [235]);
    }
    await command(`MAIL FROM:<${bareAddress(config.from)}>`, [250]);
    await command(`RCPT TO:<${bareAddress(header(to, "To"))}>`, [250, 251]);
    await command("DATA", [354]);
    await command(message.replace(/\r\n\./g, "\r\n..") + "\r\n.", [250]);
    await command("QUIT", [221]);
  } finally {
    socket.destroy();
  }
}

export function createMailer(env = process.env, log = console.log) {
  if (!env.SMTP_HOST) {
    return {
      dev: true,
      send: async ({ to, subject, text }) => log(`[e-mail dev] para=${to} assunto=${subject}\n${text}\n`)
    };
  }
  const config = {
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.SMTP_FROM || env.SMTP_USER,
    tls: env.SMTP_TLS !== "off"
  };
  if (!config.from) throw new Error("Defina SMTP_FROM (ou SMTP_USER) para enviar e-mails.");
  return { dev: false, send: mail => smtpSend(config, mail) };
}
