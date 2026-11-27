#!/bin/bash
# Sobe um cluster PostgreSQL nativo e temporário (sem Docker nem contêiner), roda os testes
# de server/ contra ele com cobertura e derruba tudo ao final.
# Cenário extra: um banco preparado do jeito legado (deploy/postgres/*.sql + _migrations como o
# serve.mjs grava) precisa ser assumido pelo backend nativo sem reaplicar a migração e sem perder salas.
# Uso: scripts/pg-test.sh   (a partir de qualquer diretório; exige PostgreSQL em /usr/lib/postgresql)
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
[ -n "${BIN:-}" ] || { echo "PostgreSQL não encontrado em /usr/lib/postgresql/*/bin" >&2; exit 1; }
DIR=$(mktemp -d /tmp/sail-pgtest.XXXXXX)
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  "$BIN/pg_ctl" -D "$DIR/data" -m fast -w stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT
"$BIN/initdb" -D "$DIR/data" -A trust -E UTF8 --no-sync >/dev/null
"$BIN/pg_ctl" -D "$DIR/data" -l "$DIR/postgres.log" -w \
  -o "-k $DIR -p 54329 -c listen_addresses='' -c fsync=off" start >/dev/null
PSQL=("$BIN/psql" -h "$DIR" -p 54329 -v ON_ERROR_STOP=1 -q)
# Socket Unix com caminho percent-encoded; a porta só nomeia o arquivo do socket (diretório é único).
SOCKET=$(printf '%s' "$DIR" | sed 's|/|%2F|g')

echo "== testes de server/ com cobertura =="
export DATABASE_URL="postgresql://$SOCKET:54329/postgres"
node --test \
  --experimental-test-coverage \
  --test-coverage-include='server/*.mjs' --test-coverage-exclude='server/*.test.mjs' \
  --test-coverage-lines=80 --test-coverage-functions=80 --test-coverage-branches=80 \
  server/*.test.mjs

echo "== cenário: banco migrado pelo caminho legado =="
"${PSQL[@]}" -d postgres -qc "CREATE DATABASE legado"
# Prepara o esquema como o serve.mjs faz: tabela _migrations, cada deploy/postgres/*.sql e o registro.
APPLIED=$(( $(date +%s) * 1000 ))
"${PSQL[@]}" -d legado -c "CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied BIGINT NOT NULL)"
for f in deploy/postgres/*.sql; do
  "${PSQL[@]}" -d legado -f "$f"
  "${PSQL[@]}" -d legado -c "INSERT INTO _migrations(name,applied) VALUES('$(basename "$f")',$APPLIED)"
done
# Sala criada pelo backend legado, com o anfitrião na vaga 0.
NOW=$(date +%s%3N)
"${PSQL[@]}" -d legado -c "INSERT INTO rooms(code,settings,created,expires) VALUES('LEGADO2','{\"venue\":\"central\"}',$NOW,$((NOW + 86400000)))"
"${PSQL[@]}" -d legado -c "INSERT INTO sailors(room,seat,id,token,name,seen) VALUES('LEGADO2',0,'leg-host','123e4567-e89b-42d3-a456-426614174000','Legado',$NOW)"

PORT=53931 DATABASE_URL="postgresql://$SOCKET:54329/legado" SAIL_ENV=test SAIL_BASE_URL="http://127.0.0.1:53931" \
  node server/main.mjs > "$DIR/main.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 20); do
  curl -fsS -m 2 -o /dev/null "http://127.0.0.1:53931/__deploy" 2>/dev/null && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "server/main.mjs morreu na partida" >&2; cat "$DIR/main.log" >&2; exit 1; }
  sleep 0.5
done

node deploy/e2e.mjs http://127.0.0.1:53931

node --input-type=module <<'JS'
// A API de salas exige sessão (ADR-0005): cria conta, confirma pela rota de teste e entra.
import { createHash } from "node:crypto";
const post = (a, b, cookie = "") => fetch(`http://127.0.0.1:53931/api/${a}`, {
  method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(b)
});
const solve = ({ challenge, signature }) => {
  const bits = Number(challenge.split(".")[2]);
  for (let nonce = 0; ; nonce++) {
    const digest = createHash("sha256").update(`${challenge}.${nonce}`).digest();
    let zeros = 0;
    for (const byte of digest) { if (byte === 0) { zeros += 8; continue; } zeros += Math.clz32(byte) - 24; break; }
    if (zeros >= bits) return { challenge, signature, nonce };
  }
};
const email = "legado@teste.invalid";
const challenge = await (await post("auth/challenge", {})).json();
await post("auth/signup", { email, password: "senha-do-cenario", pow: solve(challenge) });
await post("auth/test-confirm", { email });
const login = await post("auth/login", { email, password: "senha-do-cenario" });
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!cookie) { console.error("FALHOU: login do cenário legado"); process.exit(1); }

const r = await post("rooms/sync", { code: "LEGADO2", token: "123e4567-e89b-42d3-a456-426614174000" }, cookie);
if (r.status !== 200) { console.error("FALHOU: sala do banco legado ilegível:", r.status); process.exit(1); }
const room = await r.json();
if (!room.players.some(p => p.name === "Legado" && p.seat === 0)) {
  console.error("FALHOU: anfitrião legado ausente na sala"); process.exit(1);
}
console.log("ok: sala do banco legado continua legível pelo backend nativo");
JS

REGISTRO=$("${PSQL[@]}" -qtA -d legado -c "SELECT applied FROM _migrations WHERE name='0000_regatta_rooms.sql'")
[ "$REGISTRO" = "$APPLIED" ] || { echo "FALHOU: migração 0000 reaplicada ou registro alterado (applied=$REGISTRO, esperado $APPLIED)" >&2; exit 1; }
echo "ok: migração 0000 não foi reaplicada sobre o banco legado"
kill "$APP_PID" && wait "$APP_PID" 2>/dev/null || true
APP_PID=""
echo "cenário legado concluído"
