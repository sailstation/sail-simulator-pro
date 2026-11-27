// Testes do fluxo de contas (ADR-0005) contra PostgreSQL real, chamando auth.handle direto.
// Requer DATABASE_URL (use scripts/pg-test.sh). scrypt com parâmetros leves para rodar rápido.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPool, migrate } from "./db.mjs";
import { createAuthApi, normalizeEmail } from "./auth.mjs";
import { createPow, leadingZeroBits } from "./pow.mjs";

let pool, clock, auth;
const sent = []; // e-mails "enviados"

const mail = { send: async message => { sent.push(message); } };
const pow = createPow({ secret: "segredo-teste", bits: 2, now: () => clock });

function solve(challenge) {
  const bits = Number(challenge.split(".")[2]);
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(createHash("sha256").update(`${challenge}.${nonce}`).digest()) >= bits) return { challenge, nonce };
  }
}
const solvedPow = () => { const { challenge, signature } = pow.issue(); return { ...solve(challenge), signature }; };

const PASS = "senha-bem-forte";
let seq = 0;
const freshEmail = () => `pessoa${Date.now()}-${seq++}@exemplo.com`;
const freshIp = () => `10.${(seq >> 8) & 255}.${seq & 255}.${(seq * 7) % 250 + 1}`;

async function signup(email, password = PASS, ip = freshIp()) {
  return auth.handle("signup", { email, password, pow: solvedPow() }, { ip });
}
async function confirmFromMail() {
  const token = /#confirmar=([A-Za-z0-9_-]+)/.exec(sent.at(-1).text)[1];
  return auth.handle("confirm", { token }, {});
}
async function login(email, password = PASS, ip = freshIp()) {
  return auth.handle("login", { email, password }, { ip });
}
const sessionToken = result => /sail_session=([A-Za-z0-9_-]{43})/.exec(result.cookie ?? "")[1];

before(async () => {
  pool = createPool();
  await migrate(pool);
  clock = Date.now();
  auth = createAuthApi(pool, {
    mail, pow, baseUrl: "https://teste.invalid", scryptParams: { N: 1024, r: 8, p: 1 }, now: () => clock
  });
});
after(async () => { await pool.end(); });

test("cadastro cria conta pendente, envia confirmação e o link ativa a conta", async () => {
  const email = freshEmail();
  const result = await signup(email);
  assert.equal(result.status, 200);
  assert.match(result.body.message, /e-mail/);
  assert.equal(sent.at(-1).to, email);
  assert.match(sent.at(-1).subject, /Confirme/);
  const { rows } = await pool.query("SELECT confirmed FROM users WHERE email=$1", [email]);
  assert.equal(rows[0].confirmed, null, "conta pendente até confirmar");
  const confirmed = await confirmFromMail();
  assert.equal(confirmed.status, 200);
  const after = await pool.query("SELECT confirmed FROM users WHERE email=$1", [email]);
  assert.equal(typeof after.rows[0].confirmed, "number");
});

test("token de confirmação é de uso único e token inválido é recusado", async () => {
  const email = freshEmail();
  await signup(email);
  const token = /#confirmar=([A-Za-z0-9_-]+)/.exec(sent.at(-1).text)[1];
  assert.equal((await auth.handle("confirm", { token }, {})).status, 200);
  assert.equal((await auth.handle("confirm", { token }, {})).status, 400, "segundo uso falha");
  assert.equal((await auth.handle("confirm", { token: "x".repeat(43) }, {})).status, 400);
});

test("cadastro repetido responde igual e avisa por e-mail, sem revelar a conta", async () => {
  const email = freshEmail();
  await signup(email);
  await confirmFromMail();
  const antes = sent.length;
  const repetido = await signup(email, "outra-senha-forte");
  assert.equal(repetido.status, 200);
  assert.match(repetido.body.message, /Se os dados estiverem certos/);
  assert.equal(sent.length, antes + 1);
  assert.match(sent.at(-1).text, /já está cadastrado/);
  // A senha original continua valendo; a do cadastro repetido, não.
  assert.equal((await login(email)).status, 200);
  assert.equal((await login(email, "outra-senha-forte")).status, 401);
});

test("cadastro pendente repetido reenvia a confirmação", async () => {
  const email = freshEmail();
  await signup(email);
  const antes = sent.length;
  await signup(email);
  assert.equal(sent.length, antes + 1);
  assert.match(sent.at(-1).subject, /Confirme/);
});

test("validações: e-mail malformado, senha curta e prova de trabalho inválida", async () => {
  assert.equal((await signup("sem-arroba")).status, 400);
  assert.equal((await signup("a<b@c.de")).status, 400, "argumento de envelope SMTP (<>) não é e-mail");
  assert.equal((await signup("a>b@c.de")).status, 400);
  assert.equal((await signup(freshEmail(), "curta")).status, 400);
  const semPow = await auth.handle("signup", { email: freshEmail(), password: PASS, pow: { challenge: "x", signature: "y", nonce: 1 } }, { ip: freshIp() });
  assert.equal(semPow.status, 403);
  assert.equal((await auth.handle("signup", { email: freshEmail(), password: PASS }, { ip: freshIp() })).status, 403, "sem pow");
});

test("e-mail é normalizado: maiúsculas e espaços não criam contas diferentes", async () => {
  assert.equal(normalizeEmail("  Ana@Exemplo.COM "), "ana@exemplo.com");
  const email = freshEmail();
  await signup(email.toUpperCase());
  await confirmFromMail();
  assert.equal((await login(` ${email.toUpperCase()} `)).status, 200);
});

test("login exige conta confirmada; depois devolve cookie de sessão válido", async () => {
  const email = freshEmail();
  await signup(email);
  const pendente = await login(email);
  assert.equal(pendente.status, 403);
  assert.match(pendente.body.error, /Confirme seu e-mail/);
  await confirmFromMail();
  const entrou = await login(email);
  assert.equal(entrou.status, 200);
  assert.equal(entrou.body.email, email);
  assert.match(entrou.cookie, /HttpOnly/);
  assert.match(entrou.cookie, /Secure/);
  assert.match(entrou.cookie, /SameSite=Lax/);
  const user = await auth.session(sessionToken(entrou));
  assert.equal(user.email, email);
  assert.equal(await auth.session("token-que-nao-existe-00000000000000000000"), null);
  assert.equal(await auth.session(null), null);
});

test("senha errada e e-mail inexistente dão a mesma resposta", async () => {
  const email = freshEmail();
  await signup(email);
  await confirmFromMail();
  const errada = await login(email, "senha-errada-123");
  const inexistente = await login(freshEmail(), "senha-errada-123");
  assert.equal(errada.status, 401);
  assert.equal(inexistente.status, 401);
  assert.equal(errada.body.error, inexistente.body.error);
});

test("5 falhas bloqueiam o e-mail; sucesso antes do bloqueio zera a conta", async () => {
  const email = freshEmail();
  await signup(email);
  await confirmFromMail();
  for (let i = 0; i < 4; i++) assert.equal((await login(email, "errada-senha-1")).status, 401);
  assert.equal((await login(email)).status, 200, "sucesso antes do limite");
  for (let i = 0; i < 4; i++) await login(email, "errada-senha-1");
  assert.equal((await login(email)).status, 200, "contador zerado pelo sucesso");
  for (let i = 0; i < 5; i++) await login(email, "errada-senha-1");
  const bloqueado = await login(email);
  assert.equal(bloqueado.status, 429);
  assert.match(bloqueado.body.error, /Muitas tentativas/);
  clock += 16 * 60_000; // janela e bloqueio expiram
  assert.equal((await login(email)).status, 200);
});

test("limite por IP bloqueia força bruta com e-mails variados", async () => {
  const ip = freshIp();
  for (let i = 0; i < 20; i++) await login(freshEmail(), "senha-errada-99", ip);
  assert.equal((await login(freshEmail(), "senha-errada-99", ip)).status, 429);
  assert.equal((await login(freshEmail(), "senha-errada-99")).status, 401, "outro IP não é afetado");
});

test("bloqueio é progressivo: nova rajada dobra a pena até o teto", async () => {
  const rapido = createAuthApi(pool, {
    mail, pow, scryptParams: { N: 1024, r: 8, p: 1 }, now: () => clock,
    limits: { ...authLimits(), loginEmail: { max: 2, windowMs: 60_000, blockMs: 1_000, maxBlockMs: 4_000 } }
  });
  const email = freshEmail();
  await signup(email);
  await confirmFromMail();
  const blockedUntil = async () => (await pool.query("SELECT blocked_until FROM auth_attempts WHERE scope='email' AND key=$1", [email])).rows[0].blocked_until;
  await rapido.handle("login", { email, password: "errada-senha-1" }, { ip: freshIp() });
  await rapido.handle("login", { email, password: "errada-senha-1" }, { ip: freshIp() });
  assert.equal(await blockedUntil() - clock, 1_000, "primeira pena");
  clock += 2_000;
  await rapido.handle("login", { email, password: "errada-senha-1" }, { ip: freshIp() });
  assert.equal(await blockedUntil() - clock, 2_000, "pena dobrada");
  clock += 3_000;
  for (let i = 0; i < 3; i++) await rapido.handle("login", { email, password: "errada-senha-1" }, { ip: freshIp() });
  assert.equal(await blockedUntil() - clock, 4_000, "pena no teto");
});
function authLimits() {
  return { loginIp: { max: 1000, windowMs: 60_000, blockMs: 1_000, maxBlockMs: 1_000 },
    signupIp: { max: 1000, windowMs: 60_000, blockMs: 1_000, maxBlockMs: 1_000 },
    recoverIp: { max: 1000, windowMs: 60_000, blockMs: 1_000, maxBlockMs: 1_000 } };
}

test("recuperação: token por e-mail redefine a senha, revoga sessões e é de uso único", async () => {
  const email = freshEmail();
  await signup(email);
  await confirmFromMail();
  const sessao = await login(email);
  const pedido = await auth.handle("recover", { email, pow: solvedPow() }, { ip: freshIp() });
  assert.equal(pedido.status, 200);
  assert.match(sent.at(-1).subject, /Redefinir/);
  const token = /#redefinir=([A-Za-z0-9_-]+)/.exec(sent.at(-1).text)[1];
  // Senha fraca não consome o token.
  assert.equal((await auth.handle("reset", { token, password: "curta" }, {})).status, 400);
  const nova = await auth.handle("reset", { token, password: "senha-nova-forte" }, {});
  assert.equal(nova.status, 200);
  assert.equal((await auth.handle("reset", { token, password: "outra-senha-forte" }, {})).status, 400, "token já usado");
  assert.equal(await auth.session(sessionToken(sessao)), null, "sessão antiga revogada");
  assert.equal((await login(email)).status, 401, "senha antiga não vale mais");
  assert.equal((await login(email, "senha-nova-forte")).status, 200);
});

test("recuperação para e-mail inexistente responde igual e não envia nada", async () => {
  const antes = sent.length;
  const result = await auth.handle("recover", { email: freshEmail(), pow: solvedPow() }, { ip: freshIp() });
  assert.equal(result.status, 200);
  assert.match(result.body.message, /Se houver uma conta/);
  assert.equal(sent.length, antes, "nenhum e-mail enviado");
});

test("token de recuperação expira em 1 hora", async () => {
  const email = freshEmail();
  await signup(email);
  await confirmFromMail();
  await auth.handle("recover", { email, pow: solvedPow() }, { ip: freshIp() });
  const token = /#redefinir=([A-Za-z0-9_-]+)/.exec(sent.at(-1).text)[1];
  clock += 61 * 60_000;
  assert.equal((await auth.handle("reset", { token, password: "senha-nova-forte" }, {})).status, 400);
});

test("pedidos de recuperação são limitados por IP", async () => {
  const ip = freshIp();
  const pedir = () => auth.handle("recover", { email: freshEmail(), pow: solvedPow() }, { ip });
  for (let i = 0; i < 10; i++) assert.equal((await pedir()).status, 200);
  assert.equal((await pedir()).status, 429);
});

test("reenvio de confirmação: só para conta pendente, com resposta genérica", async () => {
  const pendente = freshEmail();
  await signup(pendente);
  const antes = sent.length;
  const generico = await auth.handle("resend", { email: pendente, pow: solvedPow() }, { ip: freshIp() });
  assert.equal(generico.status, 200);
  assert.equal(sent.length, antes + 1, "pendente recebeu novo e-mail");
  const confirmada = freshEmail();
  await signup(confirmada);
  await confirmFromMail();
  const total = sent.length;
  const igual = await auth.handle("resend", { email: confirmada, pow: solvedPow() }, { ip: freshIp() });
  assert.equal(igual.status, 200);
  assert.equal(igual.body.message, generico.body.message, "resposta não revela o estado da conta");
  assert.equal(sent.length, total, "conta confirmada não recebe");
  assert.equal((await auth.handle("resend", { email: pendente, pow: { challenge: "x" } }, { ip: freshIp() })).status, 403);
});

test("sair encerra a sessão; sair de todos encerra as demais", async () => {
  const email = freshEmail();
  await signup(email);
  await confirmFromMail();
  const a = await login(email);
  const b = await login(email);
  assert.equal((await auth.handle("logout", {}, { token: sessionToken(a) })).status, 200);
  assert.match((await auth.handle("logout", {}, { token: sessionToken(a) })).cookie, /Max-Age=0/);
  assert.equal(await auth.session(sessionToken(a)), null);
  assert.ok(await auth.session(sessionToken(b)), "outra sessão continua");
  assert.equal((await auth.handle("logout-all", {}, { token: sessionToken(b) })).status, 200);
  assert.equal(await auth.session(sessionToken(b)), null);
  assert.equal((await auth.handle("logout-all", {}, { token: "nada" })).status, 401);
});

test("sessão expirada não vale e a limpeza remove as vencidas", async () => {
  const email = freshEmail();
  await signup(email);
  await confirmFromMail();
  const sessao = await login(email);
  const token = sessionToken(sessao);
  assert.ok(await auth.session(token));
  // Vence esta sessão direto no banco (sem mexer no relógio, para não afetar outros testes).
  await pool.query("UPDATE sessions SET expires=$1 WHERE token_hash=$2",
    [clock - 1000, createHash("sha256").update(token).digest("hex")]);
  assert.equal(await auth.session(token), null, "expirada");
  await login(email); // abre sessão nova e limpa as vencidas
  const { rows } = await pool.query("SELECT 1 FROM sessions WHERE expires <= $1", [clock]);
  assert.equal(rows.length, 0);
});

test("test-confirm só existe em modo de teste", async () => {
  const email = freshEmail();
  await signup(email);
  const producao = createAuthApi(pool, { mail, pow, scryptParams: { N: 1024, r: 8, p: 1 }, now: () => clock });
  assert.equal((await producao.handle("test-confirm", { email }, {})).status, 404);
  const teste = createAuthApi(pool, { mail, pow, scryptParams: { N: 1024, r: 8, p: 1 }, now: () => clock, testMode: true });
  assert.equal((await teste.handle("test-confirm", { email }, {})).status, 200);
  assert.equal((await login(email)).status, 200);
  assert.equal((await teste.handle("test-confirm", { email }, {})).status, 404, "já confirmada");
});

test("challenge devolve desafio verificável e ação desconhecida dá 404", async () => {
  const desafio = await auth.handle("challenge", {}, {});
  assert.equal(desafio.status, 200);
  assert.match(desafio.body.challenge, /^[0-9a-f]{32}\.\d+\.\d+$/);
  assert.match(desafio.body.signature, /^[0-9a-f]{64}$/);
  assert.equal((await auth.handle("voar", {}, {})).status, 404);
});
