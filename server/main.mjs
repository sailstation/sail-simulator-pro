// Servidor do Sail Simulator Pro: estáticos de dist/, API /api/auth/* e /api/rooms/* e
// /__deploy (ADR-0004 e ADR-0005). Com o login obrigatório ligado, sem sessão válida o site
// redireciona para /login.html e a API responde 401.
// Variáveis de ambiente: DATABASE_URL (obrigatória), PORT (padrão 9000), SAIL_ENV
// ("test" habilita a rota de confirmação usada pelo e2e e liga o login sempre),
// SAIL_LOGIN_REQUIRED (liga/desliga o login; padrão: ligado com SMTP_HOST, desligado sem),
// SAIL_POW_SECRET e SAIL_POW_BITS (captcha por prova de trabalho), SAIL_BASE_URL (links dos
// e-mails) e SMTP_* (server/mail.mjs).
import http from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPool, migrate } from "./db.mjs";
import { createRoomsApi } from "./rooms.mjs";
import { createAuthApi } from "./auth.mjs";
import { createPow } from "./pow.mjs";
import { createMailer } from "./mail.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_BODY = 64 * 1024;
const MAX_JSON = 4096;
const MIME = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  jpg: "image/jpeg",
  webp: "image/webp",
  png: "image/png"
};
// Únicos caminhos servidos sem sessão: a tela de entrada e os assets dela.
const PUBLIC_PATHS = new Set(["/login.html", "/login.css", "/login.js", "/sail-simulator-pro-splash.webp"]);
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=15552000",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

// Login obrigatório (ADR-0005): com e-mail configurado (SMTP_HOST), o padrão é ligado; sem
// e-mail, desligado, para a release subir na transição sem trancar o site nem o GitOps
// (o health check antigo exige 404 da API de salas). SAIL_ENV=test liga sempre, com os
// e-mails no log quando não há SMTP. SAIL_LOGIN_REQUIRED=1/0 força o valor fora de teste.
export function loginRequiredFrom(env) {
  if (env.SAIL_ENV === "test") return true;
  if (env.SAIL_LOGIN_REQUIRED) return !/^(0|false|off|no)$/i.test(env.SAIL_LOGIN_REQUIRED);
  return Boolean(env.SMTP_HOST);
}

// Estáticos de dist/ carregados em memória com ETag (mesmo critério do antigo build do Worker).
export function loadAssets(distDir = path.join(ROOT, "dist")) {
  return Object.fromEntries(readdirSync(distDir, { withFileTypes: true })
    .filter(file => file.isFile())
    .map(({ name }) => {
      const type = MIME[name.split(".").pop()];
      if (!type) throw new Error("Tipo de asset não suportado: " + name);
      const bytes = readFileSync(path.join(distDir, name));
      const etag = '"' + createHash("sha256").update(bytes).digest("hex").slice(0, 20) + '"';
      return ["/" + name, [type, etag, bytes]];
    }));
}

// O servidor só escuta em 127.0.0.1 atrás do Caddy, que preenche X-Forwarded-For.
// O cabeçalho só é confiável vindo do proxy local, e o IP real é o ÚLTIMO da lista:
// o Caddy acrescenta o IP do cliente ao final, então valores anteriores podem ter sido
// forjados pelo próprio cliente (usar o primeiro permitiria furar o limite de tentativas).
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export function clientIp(req) {
  const peer = req.socket.remoteAddress || "";
  if (!LOOPBACK.has(peer)) return peer;
  const forwarded = req.headers["x-forwarded-for"];
  return (forwarded && forwarded.split(",").pop().trim()) || peer;
}

async function readBody(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413);
      res.end();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createApp({ pool, deployInfo = "{}", assets = loadAssets(), auth, loginRequired = true }) {
  if (!auth) throw new Error("createApp precisa de auth (createAuthApi).");
  const rooms = createRoomsApi(pool);

  const reply = (res, data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };

  // POST com JSON, mesma origem quando o navegador manda Origin (CSRF: ver ADR-0005).
  async function jsonPost(req, res) {
    if (req.method !== "POST") { reply(res, { error: "Método inválido." }, 405); return null; }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* Origin malformado: recusado abaixo */ }
      if (host === null || host !== req.headers.host) { reply(res, { error: "Origem inválida." }, 403); return null; }
    }
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) { reply(res, { error: "Formato inválido." }, 415); return null; }
    const body = await readBody(req, res);
    if (body === null) return null;
    if (body.length > MAX_JSON) { reply(res, { error: "Pedido muito grande." }, 413); return null; }
    let data;
    try { data = JSON.parse(body.toString("utf8")); } catch { data = null; }
    if (!data || typeof data !== "object") { reply(res, { error: "Pedido inválido." }, 400); return null; }
    return data;
  }

  async function handleAuth(req, res, pathname) {
    const data = await jsonPost(req, res);
    if (data === null) return;
    try {
      const result = await auth.handle(pathname.split("/").pop(), data, { ip: clientIp(req), token: auth.tokenFrom(req) });
      if (result.cookie) res.setHeader("Set-Cookie", result.cookie);
      reply(res, result.body, result.status);
    } catch (error) {
      console.error("falha na autenticação", error);
      reply(res, { error: "Não foi possível concluir agora. Tente de novo." }, 503);
    }
  }

  async function handleRooms(req, res, pathname) {
    const data = await jsonPost(req, res);
    if (data === null) return;
    if (loginRequired && !await auth.session(auth.tokenFrom(req))) return reply(res, { error: "Entre para jogar." }, 401);
    try {
      const result = await rooms.handle(pathname.split("/").pop(), data);
      reply(res, result.body, result.status);
    } catch (error) {
      console.error("falha na sala", error);
      reply(res, { error: "Não foi possível conectar à sala." }, 503);
    }
  }

  async function serveStatic(req, res, pathname) {
    if (loginRequired && !PUBLIC_PATHS.has(pathname) && !await auth.session(auth.tokenFrom(req))) {
      if (["GET", "HEAD"].includes(req.method)) {
        res.writeHead(302, { Location: "/login.html", "Cache-Control": "no-store" });
        return res.end();
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Página não encontrada.");
    }
    const entry = assets[pathname === "/" ? "/index.html" : pathname];
    if (!entry || !["GET", "HEAD"].includes(req.method)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Página não encontrada.");
    }
    const [type, etag, bytes] = entry;
    // private: conteúdo atrás de sessão não pode ser guardado por cache compartilhado.
    const headers = { "Content-Type": type, ETag: etag, "Cache-Control": "private, max-age=0, must-revalidate" };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : bytes);
  }

  return http.createServer(async (req, res) => {
    try {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      const { pathname } = new URL(req.url, "http://localhost");
      if (pathname === "/__deploy") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(deployInfo);
      }
      if (pathname.startsWith("/api/auth/")) return await handleAuth(req, res, pathname);
      if (pathname.startsWith("/api/rooms/")) return await handleRooms(req, res, pathname);
      return await serveStatic(req, res, pathname);
    } catch (error) {
      console.error("falha na requisição", req.method, req.url, error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const pool = createPool();
  await migrate(pool);
  const deployFile = path.join(ROOT, "DEPLOY.json");
  const deployInfo = existsSync(deployFile) ? readFileSync(deployFile, "utf8") : "{}";
  const port = Number(process.env.PORT || 9000);
  if (!process.env.SAIL_POW_SECRET) {
    console.warn("SAIL_POW_SECRET não definido: usando um segredo aleatório deste processo; " +
      "desafios do captcha em aberto invalidam a cada reinício (aceitável, mas defina o segredo em produção).");
  }
  const pow = createPow({ secret: process.env.SAIL_POW_SECRET, bits: Number(process.env.SAIL_POW_BITS || 16) });
  const auth = createAuthApi(pool, {
    mail: createMailer(process.env),
    pow,
    baseUrl: process.env.SAIL_BASE_URL || `http://127.0.0.1:${port}`,
    testMode: process.env.SAIL_ENV === "test"
  });
  const loginRequired = loginRequiredFrom(process.env);
  console.log(`login obrigatório: ${loginRequired ? "ligado" : "desligado (site e salas abertos; SMTP_HOST ou SAIL_LOGIN_REQUIRED=1 ligam)"}`);
  createApp({ pool, deployInfo, auth, loginRequired }).listen(port, "127.0.0.1",
    () => console.log(`sail ouvindo em 127.0.0.1:${port}`));
}
