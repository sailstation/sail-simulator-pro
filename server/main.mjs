// Servidor do Sail Simulator Pro: estáticos de dist/, API /api/rooms/* e /__deploy (ADR-0004).
// Variáveis de ambiente: DATABASE_URL (PostgreSQL, obrigatória) e PORT (padrão 9000).
import http from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPool, migrate } from "./db.mjs";
import { createRoomsApi } from "./rooms.mjs";

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

function serveStatic(req, res, assets, pathname) {
  const entry = assets[pathname === "/" ? "/index.html" : pathname];
  if (!entry || !["GET", "HEAD"].includes(req.method)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Página não encontrada.");
  }
  const [type, etag, bytes] = entry;
  const headers = { "Content-Type": type, ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate" };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : bytes);
}

export function createApp({ pool, deployInfo = "{}", assets = loadAssets() } = {}) {
  const rooms = createRoomsApi(pool);
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (pathname === "/__deploy") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(deployInfo);
      }
      if (!pathname.startsWith("/api/rooms/")) return serveStatic(req, res, assets, pathname);

      const reply = (data, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(data));
      };
      if (req.method !== "POST") return reply({ error: "Método inválido." }, 405);
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return reply({ error: "Origem inválida." }, 403);
      if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return reply({ error: "Formato inválido." }, 415);
      const body = await readBody(req, res);
      if (body === null) return;
      if (body.length > MAX_JSON) return reply({ error: "Pedido muito grande." }, 413);
      let data;
      try { data = JSON.parse(body.toString("utf8")); } catch { return reply({ error: "Pedido inválido." }, 400); }
      if (!data || typeof data !== "object") return reply({ error: "Pedido inválido." }, 400);
      try {
        const result = await rooms.handle(pathname.split("/").pop(), data);
        reply(result.body, result.status);
      } catch (error) {
        console.error("falha na sala", error);
        reply({ error: "Não foi possível conectar à sala." }, 503);
      }
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
  createApp({ pool, deployInfo }).listen(port, "127.0.0.1",
    () => console.log(`sail ouvindo em 127.0.0.1:${port}`));
}
