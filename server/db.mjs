// Pool PostgreSQL e migrações do backend de salas (ADR-0004).
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";

// BIGINT (timestamps em ms) volta como número, como era no D1.
pg.types.setTypeParser(20, Number);

export const MIGRATIONS = new URL("../db/migrations/", import.meta.url);

// Aceita os formatos do libpq, inclusive socket Unix percent-encoded:
// postgresql://%2Fvar%2Frun%2Fpostgresql/sail_prod
export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("Defina DATABASE_URL (ex.: postgresql://%2Fvar%2Frun%2Fpostgresql/sail_prod).");
  }
  return new pg.Pool({ connectionString, max: 10 });
}

// Aplica db/migrations/*.sql em ordem alfabética, uma única vez cada, registrando em _migrations.
// A trava consultiva serializa migrações simultâneas (testes em paralelo, processos subindo juntos).
const MIGRATION_LOCK = 727001;
export async function migrate(pool, dir = MIGRATIONS) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied BIGINT NOT NULL)");
    for (const name of readdirSync(dir).filter(file => file.endsWith(".sql")).sort()) {
      if ((await client.query("SELECT 1 FROM _migrations WHERE name=$1", [name])).rowCount) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(new URL(name, dir), "utf8"));
        await client.query("INSERT INTO _migrations(name,applied) VALUES($1,$2)", [name, Date.now()]);
        await client.query("COMMIT");
        console.log("migração aplicada", name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
