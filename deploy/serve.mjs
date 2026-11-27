// Hospeda o Worker do Sail Simulator Pro em Node, com PostgreSQL no lugar do D1.
// Variáveis: SAIL_APP (release atual), SAIL_PORT, SAIL_DB (banco PostgreSQL), SAIL_ENV, SAIL_SCHEMA.
import http from "node:http";
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

// BIGINT (timestamps em ms) volta como número, como no D1.
pg.types.setTypeParser(20, Number);

const app = realpathSync(process.env.SAIL_APP);
const port = Number(process.env.SAIL_PORT);
const schemaDir = process.env.SAIL_SCHEMA || "/opt/sail/schema";
const MAX_BODY = 64 * 1024;

// Conexão por socket Unix com autenticação peer (usuário do sistema = papel no Postgres).
const pool = new pg.Pool({ host: "/var/run/postgresql", database: process.env.SAIL_DB, max: 10 });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied BIGINT NOT NULL)");
    for (const name of readdirSync(schemaDir).filter(f => f.endsWith(".sql")).sort()) {
      if ((await client.query("SELECT 1 FROM _migrations WHERE name=$1", [name])).rowCount) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(path.join(schemaDir, name), "utf8"));
        await client.query("INSERT INTO _migrations(name,applied) VALUES($1,$2)", [name, Date.now()]);
        await client.query("COMMIT");
        console.log("migração aplicada", name);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } finally { client.release(); }
}
await migrate();

// Subconjunto da API do D1 usado por worker/index.js, traduzido para PostgreSQL.
const toPg = text => { let n = 0; return text.replace(/\?/g, () => "$" + (++n)); };
const statement = (text, params) => ({
  text: toPg(text), params,
  all: async () => ({ results: (await pool.query(toPg(text), params)).rows }),
  first: async () => (await pool.query(toPg(text), params)).rows[0] ?? null,
  run: async () => ({ meta: { changes: (await pool.query(toPg(text), params)).rowCount } })
});
const DB = {
  prepare: text => ({ bind: (...params) => statement(text, params), ...statement(text, []) }),
  async batch(stmts) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = [];
      for (const s of stmts) out.push({ meta: { changes: (await client.query(s.text, s.params)).rowCount } });
      await client.query("COMMIT");
      return out;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
};

const worker = (await import(pathToFileURL(path.join(app, "dist/server/index.js")).href)).default;
const deployInfo = existsSync(path.join(app, "DEPLOY.json")) ? readFileSync(path.join(app, "DEPLOY.json"), "utf8") : "{}";

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/__deploy") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(deployInfo);
    }
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) { res.writeHead(413); return res.end(); }
      chunks.push(chunk);
    }
    const host = req.headers.host || "localhost";
    const request = new Request(new URL(req.url, `https://${host}`), {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]]),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks)
    });
    const response = await worker.fetch(request, { DB });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("falha na requisição", req.method, req.url, error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`${process.env.SAIL_ENV} ouvindo em 127.0.0.1:${port}, release ${app}`));
