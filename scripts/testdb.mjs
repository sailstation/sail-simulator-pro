// Esquema PostgreSQL descartável por arquivo de teste.
// Cada suíte roda num esquema t_<hex> aleatório do banco apontado por DATABASE_URL,
// criado no before e removido no after: a suíte pode rodar quantas vezes for contra
// o MESMO banco (ex.: sail_ci persistente no servidor) sem herdar contas e salas da
// rodada anterior. As migrações, a tabela _migrations e a trava consultiva funcionam
// dentro do esquema porque todas as queries são não qualificadas e o search_path de
// cada conexão do pool aponta para ele.
// Segurança: drop() só aceita o formato exato que createTestSchema() cria — nunca
// public nem qualquer esquema preexistente, mesmo com DATABASE_URL apontado para produção.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool } from "../server/db.mjs";

const SCHEMA_PATTERN = /^t_[0-9a-f]{16}$/;

export async function createTestSchema(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("Defina DATABASE_URL para os testes com banco (use scripts/pg-test.sh).");
  }
  const schema = "t_" + randomBytes(8).toString("hex");
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  // options "-c search_path=..." vale para TODA conexão do pool, inclusive os clientes
  // de pool.connect() usados nas transações de rooms.mjs e das migrações.
  const pool = createPool(connectionString, { options: `-c search_path=${schema}` });
  return {
    schema,
    pool,
    async drop() {
      await pool.end();
      if (!SCHEMA_PATTERN.test(schema)) throw new Error(`Recusando DROP de esquema inesperado: ${schema}`);
      const cleanup = new pg.Client({ connectionString });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
