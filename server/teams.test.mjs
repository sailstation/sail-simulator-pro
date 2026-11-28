// Testes das equipes (ADR-0007): criação, convites (nome, e-mail e link), papéis, chat com
// denúncia e limites, contra PostgreSQL real. Requer DATABASE_URL (use scripts/pg-test.sh).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { migrate } from "./db.mjs";
import { createApp } from "./main.mjs";
import { createAuthApi, LIMITS } from "./auth.mjs";
import { createTeamsApi } from "./teams.mjs";
import { createPow, leadingZeroBits } from "./pow.mjs";
import { createTestSchema } from "../scripts/testdb.mjs";

let testdb, pool, server, base, tightServer, tightBase, openServer, openBase;

before(async () => {
  testdb = await createTestSchema();
  pool = testdb.pool;
  await migrate(pool);
  const pow = createPow({ secret: "segredo-equipes", bits: 2 });
  const auth = createAuthApi(pool, {
    mail: { send: async () => {} }, pow, testMode: true, scryptParams: { N: 1024, r: 8, p: 1 },
    // A suíte cria muitas contas; o limite de cadastro em si é coberto em auth.test.mjs.
    limits: { ...LIMITS, signupIp: { ...LIMITS.signupIp, max: 1000 } }
  });
  server = createApp({ pool, deployInfo: "{}", auth });
  server.listen(0, "127.0.0.1");
  // Segunda instância com limites apertados, para os testes de teto sem esperar de verdade.
  tightServer = createApp({ pool, deployInfo: "{}", auth,
    teams: createTeamsApi(pool, { maxMembers: 2, maxTeamsPerUser: 2, invitesPerHour: 3, messagesPerMinute: 2, reportsPerHour: 2 }) });
  tightServer.listen(0, "127.0.0.1");
  // Terceira com o login desligado: sem sessão não há equipe, como no perfil (ADR-0006).
  openServer = createApp({ pool, deployInfo: "{}", auth, loginRequired: false });
  openServer.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(tightServer, "listening"), once(openServer, "listening")]);
  base = `http://127.0.0.1:${server.address().port}`;
  tightBase = `http://127.0.0.1:${tightServer.address().port}`;
  openBase = `http://127.0.0.1:${openServer.address().port}`;
});

after(async () => {
  server.close();
  tightServer.close();
  openServer.close();
  await testdb.drop();
});

const post = async (url, body, cookie) => {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  return [r.status, text ? JSON.parse(text) : null, r];
};
const teams = (action, body, cookie, app = base) => post(`${app}/api/teams/${action}`, body, cookie);

const solvePow = ({ challenge, signature }) => {
  const bits = Number(challenge.split(".")[2]);
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(createHash("sha256").update(`${challenge}.${nonce}`).digest()) >= bits) return { challenge, signature, nonce };
  }
};
let accountSeq = 0;
// Conta confirmada com perfil completo (nome, país e clube da semente), como o jogo exige.
async function velejador(name, { emoji } = {}) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${++accountSeq}@exemplo.com`;
  const [, challenge] = await post(`${base}/api/auth/challenge`, {});
  assert.equal((await post(`${base}/api/auth/signup`, { email, password: "senha-do-velejador", pow: solvePow(challenge) }))[0], 200);
  assert.equal((await post(`${base}/api/auth/test-confirm`, { email }))[0], 200);
  const [status, , r] = await post(`${base}/api/auth/login`, { email, password: "senha-do-velejador" });
  assert.equal(status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const saved = await post(`${base}/api/profile/save`, { name, country: "BR", clubId: "seed-icrj", ...(emoji ? { emoji } : {}) }, cookie);
  assert.equal(saved[0], 200);
  const [, me] = await post(`${base}/api/profile/get`, {}, cookie);
  return { cookie, email, name, id: me.you };
}

// --- acesso ----------------------------------------------------------------------------------

test("sem sessão a API de equipes responde 401, mesmo com o login desligado", async () => {
  assert.equal((await teams("get", {}))[0], 401);
  assert.equal((await teams("create", { name: "Equipe X", tag: "XX" }))[0], 401);
  assert.equal((await post(`${openBase}/api/teams/get`, {}))[0], 401, "login desligado não cria sessão");
});

test("perfil incompleto responde 403 em qualquer ação de equipe", async () => {
  const email = `sem-perfil-${++accountSeq}@exemplo.com`;
  const [, challenge] = await post(`${base}/api/auth/challenge`, {});
  await post(`${base}/api/auth/signup`, { email, password: "senha-do-velejador", pow: solvePow(challenge) });
  await post(`${base}/api/auth/test-confirm`, { email });
  const [, , r] = await post(`${base}/api/auth/login`, { email, password: "senha-do-velejador" });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.equal((await teams("get", {}, cookie))[0], 403);
  assert.equal((await teams("create", { name: "Equipe X", tag: "XX" }, cookie))[0], 403);
  assert.equal((await teams("chat", { teamId: "x" }, cookie))[0], 403);
});

test("ação desconhecida responde 404", async () => {
  const ana = await velejador("Ana Porta");
  assert.equal((await teams("explodir", {}, ana.cookie))[0], 404);
});

// --- criação ---------------------------------------------------------------------------------

test("criar equipe valida nome, sigla e país", async () => {
  const ana = await velejador("Ana Cria");
  const t = body => teams("create", body, ana.cookie);
  assert.equal((await t({ name: "ab", tag: "ABC" }))[0], 400, "nome curto");
  assert.equal((await t({ name: "a".repeat(41), tag: "ABC" }))[0], 400, "nome longo");
  assert.equal((await t({ name: "EquipeFeia", tag: "ABC" }))[0], 400, "controle no nome");
  assert.equal((await t({ name: "Equipe Boa", tag: "A" }))[0], 400, "sigla curta");
  assert.equal((await t({ name: "Equipe Boa", tag: "ABCDEF" }))[0], 400, "sigla longa");
  assert.equal((await t({ name: "Equipe Boa", tag: "A C" }))[0], 400, "sigla com espaço");
  assert.equal((await t({ name: "Equipe Boa", tag: "ABC", country: "XX" }))[0], 400, "país inválido");
});

test("quem cria vira capitão e a primeira equipe é a principal", async () => {
  const ana = await velejador("Ana Capitã");
  const [status, body] = await teams("create", { name: "Velejadores da Ana", tag: "VDA", country: "br" }, ana.cookie);
  assert.equal(status, 200);
  assert.equal(body.team.role, "captain");
  assert.equal(body.team.primary, true);
  assert.equal(body.team.country, "BR", "país normalizado");
  const [, lista] = await teams("get", {}, ana.cookie);
  const time = lista.teams.find(t => t.id === body.team.id);
  assert.equal(time.members.length, 1);
  assert.equal(time.members[0].role, "captain");
  assert.equal(time.members[0].you, true);
  assert.equal(time.members[0].avatar.type, "emoji", "avatar do membro segue o ADR-0006");
});

test("nome e sigla são únicos sem diferenciar caixa e espaços", async () => {
  const ana = await velejador("Ana Unica");
  const beto = await velejador("Beto Unico");
  assert.equal((await teams("create", { name: "Equipe  Unica", tag: "UNI" }, ana.cookie))[0], 200);
  assert.equal((await teams("create", { name: "equipe unica", tag: "OUT" }, beto.cookie))[0], 409, "nome repetido com outra caixa");
  assert.equal((await teams("create", { name: "Outra Coisa", tag: "uni" }, beto.cookie))[0], 409, "sigla repetida em minúsculas");
});

test("um jogador participa de no máximo 5 equipes (configurável)", async () => {
  const ana = await velejador("Ana Cheia");
  const dono = await velejador("Dono Cheio");
  for (let i = 0; i < 5; i++) {
    const [status, body] = await teams("create", { name: `Equipe Cheia ${i}`, tag: `CH${i}` }, dono.cookie);
    assert.equal(status, 200);
    assert.equal((await teams("invite", { teamId: body.team.id, name: "Ana Cheia" }, dono.cookie))[0], 200);
    const [, inbox] = await teams("get", {}, ana.cookie);
    const convite = inbox.invites.find(c => c.team.id === body.team.id);
    assert.equal((await teams("accept", { inviteId: convite.id }, ana.cookie))[0], 200, `aceite ${i + 1}`);
  }
  const [, lista] = await teams("get", {}, ana.cookie);
  assert.equal(lista.teams.length, 5);
  assert.equal((await teams("create", { name: "Equipe da Ana Mesmo", tag: "AME" }, ana.cookie))[0], 409, "criar a sexta é recusado");
  // Aceitar também respeita o teto: na instância apertada (máx. 2) a Ana, com 5, não entra.
  const donoExtra = await velejador("Dono Extra");
  const [, extra] = await teams("create", { name: "Equipe Cheia Extra", tag: "CHX" }, donoExtra.cookie, tightBase);
  assert.equal((await teams("invite", { teamId: extra.team.id, name: "Ana Cheia" }, donoExtra.cookie, tightBase))[0], 200);
  const [, inbox] = await teams("get", {}, ana.cookie);
  const convite = inbox.invites.find(c => c.team.id === extra.team.id);
  assert.equal((await teams("accept", { inviteId: convite.id }, ana.cookie))[0], 409, "aceitar a sexta também");
});

// --- convites por nome -----------------------------------------------------------------------

test("só o capitão convida", async () => {
  const ana = await velejador("Ana Manda");
  const beto = await velejador("Beto Obedece");
  const carla = await velejador("Carla Espera");
  const [, time] = await teams("create", { name: "Equipe Manda", tag: "MMD" }, ana.cookie);
  assert.equal((await teams("invite", { teamId: time.team.id, name: "Beto Obedece" }, ana.cookie))[0], 200);
  const [, inbox] = await teams("get", {}, beto.cookie);
  assert.equal((await teams("accept", { inviteId: inbox.invites[0].id }, beto.cookie))[0], 200);
  assert.equal((await teams("invite", { teamId: time.team.id, name: "Carla Espera" }, beto.cookie))[0], 403, "membro não convida");
  assert.equal((await teams("invite", { teamId: time.team.id, name: "Carla Espera" }, carla.cookie))[0], 404, "de fora nem vê a equipe");
});

test("convite por nome: inexistente, ambíguo, eu mesma, já membro e repetido", async () => {
  const ana = await velejador("Ana Nome");
  const beto = await velejador("Beto Nome");
  await velejador("Gemeos Nome");
  await velejador("Gemeos Nome");
  const [, time] = await teams("create", { name: "Equipe Nome", tag: "NOM" }, ana.cookie);
  const teamId = time.team.id;
  assert.equal((await teams("invite", { teamId, name: "Fantasma Nome" }, ana.cookie))[0], 404, "nome inexistente");
  assert.equal((await teams("invite", { teamId, name: "Gemeos Nome" }, ana.cookie))[0], 409, "nome ambíguo pede e-mail");
  assert.equal((await teams("invite", { teamId, name: "Ana Nome" }, ana.cookie))[0], 400, "convidar a si mesma");
  assert.equal((await teams("invite", { teamId, name: "Beto Nome" }, ana.cookie))[0], 200);
  assert.equal((await teams("invite", { teamId, name: "Beto Nome" }, ana.cookie))[0], 409, "convite repetido");
  const [, inbox] = await teams("get", {}, beto.cookie);
  const convite = inbox.invites.find(c => c.team.id === teamId);
  assert.equal(convite.team.name, "Equipe Nome");
  assert.equal(convite.from, "Ana Nome");
  assert.equal((await teams("accept", { inviteId: convite.id }, beto.cookie))[0], 200);
  assert.equal((await teams("invite", { teamId, name: "Beto Nome" }, ana.cookie))[0], 409, "quem já é membro não recebe convite");
});

test("recusar convite encerra; outra pessoa não aceita convite alheio", async () => {
  const ana = await velejador("Ana Recusa");
  const beto = await velejador("Beto Recusa");
  const carla = await velejador("Carla Intrusa");
  const [, time] = await teams("create", { name: "Equipe Recusa", tag: "REC" }, ana.cookie);
  await teams("invite", { teamId: time.team.id, name: "Beto Recusa" }, ana.cookie);
  const [, inbox] = await teams("get", {}, beto.cookie);
  const convite = inbox.invites.find(c => c.team.id === time.team.id);
  assert.equal((await teams("accept", { inviteId: convite.id }, carla.cookie))[0], 404, "convite é da pessoa convidada");
  assert.equal((await teams("decline", { inviteId: convite.id }, beto.cookie))[0], 200);
  assert.equal((await teams("accept", { inviteId: convite.id }, beto.cookie))[0], 404, "recusado não volta");
  const [, lista] = await teams("get", {}, beto.cookie);
  assert.equal(lista.teams.length, 0);
});

test("capitão revoga convite pendente; o convite some para o convidado", async () => {
  const ana = await velejador("Ana Revoga");
  const beto = await velejador("Beto Revogado");
  const [, time] = await teams("create", { name: "Equipe Revoga", tag: "RVG" }, ana.cookie);
  await teams("invite", { teamId: time.team.id, name: "Beto Revogado" }, ana.cookie);
  const [, antes] = await teams("get", {}, ana.cookie);
  const pendente = antes.teams[0].invites.find(i => i.kind === "name");
  assert.equal(pendente.to, "Beto Revogado");
  assert.equal((await teams("revoke", { teamId: time.team.id, inviteId: pendente.id }, ana.cookie))[0], 200);
  assert.equal((await teams("revoke", { teamId: time.team.id, inviteId: pendente.id }, ana.cookie))[0], 404, "já revogado");
  const [, inbox] = await teams("get", {}, beto.cookie);
  assert.equal(inbox.invites.length, 0);
});

// --- convites por e-mail ---------------------------------------------------------------------

test("convite por e-mail não revela se a conta existe", async () => {
  const ana = await velejador("Ana Email");
  const beto = await velejador("Beto Email");
  const [, time] = await teams("create", { name: "Equipe Email", tag: "EML" }, ana.cookie);
  const comConta = await teams("invite", { teamId: time.team.id, email: beto.email.toUpperCase() }, ana.cookie);
  const semConta = await teams("invite", { teamId: time.team.id, email: "ninguem@exemplo.com" }, ana.cookie);
  assert.equal(comConta[0], 200);
  assert.deepEqual(comConta[1], semConta[1], "resposta idêntica exista ou não a conta");
  // O capitão vê os dois convites pendentes — exista ou não a conta (ADR-0007).
  const [, lista] = await teams("get", {}, ana.cookie);
  const pendentes = lista.teams[0].invites.filter(i => i.kind === "email");
  assert.equal(pendentes.length, 2);
  // O convidado vê o convite na caixa de entrada e aceita.
  const [, inbox] = await teams("get", {}, beto.cookie);
  const convite = inbox.invites.find(c => c.team.id === time.team.id);
  assert.ok(convite, "convite aparece para o dono do e-mail");
  assert.equal((await teams("accept", { inviteId: convite.id }, beto.cookie))[0], 200);
  const [, depois] = await teams("get", {}, beto.cookie);
  assert.equal(depois.teams[0].members.length, 2);
});

test("convite por e-mail: validação e repetição", async () => {
  const ana = await velejador("Ana Email Dois");
  const [, time] = await teams("create", { name: "Equipe Email Dois", tag: "EM2" }, ana.cookie);
  assert.equal((await teams("invite", { teamId: time.team.id, email: "nao-e-email" }, ana.cookie))[0], 400);
  assert.equal((await teams("invite", { teamId: time.team.id, email: ana.email }, ana.cookie))[0], 400, "o próprio e-mail");
  assert.equal((await teams("invite", { teamId: time.team.id, email: "x@exemplo.com" }))[0], 401, "sem sessão");
  assert.equal((await teams("invite", { teamId: time.team.id, email: "x@exemplo.com" }, ana.cookie))[0], 200);
  assert.equal((await teams("invite", { teamId: time.team.id, email: "X@exemplo.com" }, ana.cookie))[0], 409, "repetido com outra caixa");
});

// --- convites por link -----------------------------------------------------------------------

test("link de convite com usos limitados entra direto e expira", async () => {
  const ana = await velejador("Ana Link");
  const beto = await velejador("Beto Link");
  const carla = await velejador("Carla Link");
  const [, time] = await teams("create", { name: "Equipe Link", tag: "LNK" }, ana.cookie);
  const teamId = time.team.id;
  const [status, link] = await teams("invite-link", { teamId, uses: 2 }, ana.cookie);
  assert.equal(status, 200);
  assert.ok(link.token.length > 20);
  assert.equal(link.url, `/equipe.html#convite=${link.token}`);
  assert.equal((await teams("join-link", { token: "token-errado" }, beto.cookie))[0], 404);
  assert.equal((await teams("join-link", { token: link.token }, beto.cookie))[0], 200);
  assert.equal((await teams("join-link", { token: link.token }, carla.cookie))[0], 200);
  const duda = await velejador("Duda Link");
  assert.equal((await teams("join-link", { token: link.token }, duda.cookie))[0], 404, "usos esgotados");
  // Expiração: envelhece o convite no banco.
  const [, outro] = await teams("invite-link", { teamId }, ana.cookie);
  await pool.query("UPDATE team_invites SET expires=1 WHERE team_id=$1 AND token_hash IS NOT NULL AND uses=0", [teamId]);
  assert.equal((await teams("join-link", { token: outro.token }, duda.cookie))[0], 404, "link expirado");
  assert.equal((await teams("invite-link", { teamId, uses: 0 }, ana.cookie))[0], 400);
  assert.equal((await teams("invite-link", { teamId, uses: 51 }, ana.cookie))[0], 400);
  assert.equal((await teams("invite-link", { teamId }, beto.cookie))[0], 403, "membro não cria link");
});

test("convite expirado não aparece nem aceita; revogação do capitão vale para o link", async () => {
  const ana = await velejador("Ana Expira");
  const beto = await velejador("Beto Expira");
  const [, time] = await teams("create", { name: "Equipe Expira", tag: "EXP" }, ana.cookie);
  await teams("invite", { teamId: time.team.id, name: "Beto Expira" }, ana.cookie);
  await pool.query("UPDATE team_invites SET expires=1 WHERE team_id=$1", [time.team.id]);
  const [, inbox] = await teams("get", {}, beto.cookie);
  assert.equal(inbox.invites.length, 0, "expirado não aparece na caixa");
  const [, lista] = await teams("get", {}, ana.cookie);
  assert.equal(lista.teams[0].invites.length, 0, "expirado não aparece para o capitão");
  const [, link] = await teams("invite-link", { teamId: time.team.id }, ana.cookie);
  const [, comLink] = await teams("get", {}, ana.cookie);
  const pendente = comLink.teams[0].invites.find(i => i.kind === "link");
  assert.equal((await teams("revoke", { teamId: time.team.id, inviteId: pendente.id }, ana.cookie))[0], 200);
  assert.equal((await teams("join-link", { token: link.token }, beto.cookie))[0], 404, "link revogado não entra");
});

test("limite de convites por hora (configurável)", async () => {
  const ana = await velejador("Ana Rajada");
  const [, time] = await teams("create", { name: "Equipe Rajada", tag: "RJD" }, ana.cookie);
  for (let i = 0; i < 3; i++) {
    assert.equal((await teams("invite", { teamId: time.team.id, email: `rajada-${i}@exemplo.com` }, ana.cookie, tightBase))[0], 200);
  }
  assert.equal((await teams("invite", { teamId: time.team.id, email: "rajada-4@exemplo.com" }, ana.cookie, tightBase))[0], 429);
});

// --- papéis ----------------------------------------------------------------------------------

test("transferência de capitania: só o capitão, só para membro", async () => {
  const ana = await velejador("Ana Transfere");
  const beto = await velejador("Beto Recebe");
  const carla = await velejador("Carla Fora");
  const [, time] = await teams("create", { name: "Equipe Transfere", tag: "TRF" }, ana.cookie);
  const teamId = time.team.id;
  assert.equal((await teams("transfer", { teamId, userId: beto.id }, ana.cookie))[0], 404, "alvo não é membro");
  const [, link] = await teams("invite-link", { teamId }, ana.cookie);
  await teams("join-link", { token: link.token }, beto.cookie);
  assert.equal((await teams("transfer", { teamId, userId: ana.id }, beto.cookie))[0], 403, "membro não transfere");
  assert.equal((await teams("transfer", { teamId, userId: beto.id }, ana.cookie))[0], 200);
  const [, lista] = await teams("get", {}, ana.cookie);
  const timeLista = lista.teams.find(t => t.id === teamId);
  assert.equal(timeLista.role, "member", "quem transferiu vira membro");
  assert.equal(timeLista.members.find(m => m.id === beto.id).role, "captain");
  assert.equal((await teams("transfer", { teamId, userId: carla.id }, beto.cookie))[0], 404);
});

test("remover membro: só o capitão remove, e não a si mesmo", async () => {
  const ana = await velejador("Ana Remove");
  const beto = await velejador("Beto Removido");
  const carla = await velejador("Carla Remove");
  const [, time] = await teams("create", { name: "Equipe Remove", tag: "RMV" }, ana.cookie);
  const teamId = time.team.id;
  const [, link] = await teams("invite-link", { teamId, uses: 2 }, ana.cookie);
  await teams("join-link", { token: link.token }, beto.cookie);
  await teams("join-link", { token: link.token }, carla.cookie);
  assert.equal((await teams("remove", { teamId, userId: beto.id }, carla.cookie))[0], 403, "membro não remove");
  assert.equal((await teams("remove", { teamId, userId: ana.id }, ana.cookie))[0], 400, "capitão não se remove");
  assert.equal((await teams("remove", { teamId, userId: beto.id }, ana.cookie))[0], 200);
  const [, lista] = await teams("get", {}, ana.cookie);
  assert.equal(lista.teams[0].members.length, 2);
  const [, betoLista] = await teams("get", {}, beto.cookie);
  assert.equal(betoLista.teams.length, 0);
});

test("sair: membro sai; capitão só sai transferindo ou apagando", async () => {
  const ana = await velejador("Ana Sai");
  const beto = await velejador("Beto Sai");
  const [, time] = await teams("create", { name: "Equipe Sai", tag: "SAI" }, ana.cookie);
  const teamId = time.team.id;
  assert.equal((await teams("leave", { teamId }, ana.cookie))[0], 409, "capitão sozinho apaga a equipe, não sai");
  const [, link] = await teams("invite-link", { teamId }, ana.cookie);
  await teams("join-link", { token: link.token }, beto.cookie);
  assert.equal((await teams("leave", { teamId }, ana.cookie))[0], 409, "capitão com membros transfere antes");
  assert.equal((await teams("leave", { teamId }, beto.cookie))[0], 200);
  assert.equal((await teams("leave", { teamId }, beto.cookie))[0], 404, "quem já saiu não sai de novo");
  assert.equal((await teams("leave", { teamId: "equipe-que-nao-existe" }, ana.cookie))[0], 404);
});

test("apagar a equipe: só o capitão; tudo some junto", async () => {
  const ana = await velejador("Ana Apaga");
  const beto = await velejador("Beto Fica");
  const [, time] = await teams("create", { name: "Equipe Apaga", tag: "APG" }, ana.cookie);
  const teamId = time.team.id;
  const [, link] = await teams("invite-link", { teamId }, ana.cookie);
  await teams("join-link", { token: link.token }, beto.cookie);
  await teams("send", { teamId, body: "última mensagem" }, ana.cookie);
  assert.equal((await teams("delete", { teamId }, beto.cookie))[0], 403, "membro não apaga");
  assert.equal((await teams("delete", { teamId }, ana.cookie))[0], 200);
  const [, lista] = await teams("get", {}, beto.cookie);
  assert.equal(lista.teams.length, 0);
  assert.equal((await teams("chat", { teamId }, beto.cookie))[0], 404, "chat da equipe apagada não abre");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM team_messages WHERE team_id=$1", [teamId]);
  assert.equal(rows[0].n, 0, "mensagens apagadas em cascata");
});

test("equipe principal: a primeira é principal, dá para trocar e sair promove a mais antiga", async () => {
  const ana = await velejador("Ana Principal");
  const dono = await velejador("Dono Principal");
  const [, primeira] = await teams("create", { name: "Principal Um", tag: "PUM" }, ana.cookie);
  const [, segunda] = await teams("create", { name: "Principal Dois", tag: "PDO" }, ana.cookie);
  const [, lista] = await teams("get", {}, ana.cookie);
  assert.equal(lista.teams.find(t => t.id === primeira.team.id).primary, true);
  assert.equal(lista.teams.find(t => t.id === segunda.team.id).primary, false);
  assert.equal((await teams("primary", { teamId: segunda.team.id }, ana.cookie))[0], 200);
  const [, trocada] = await teams("get", {}, ana.cookie);
  assert.equal(trocada.teams.find(t => t.id === segunda.team.id).primary, true);
  assert.equal((await teams("primary", { teamId: "equipe-alheia" }, ana.cookie))[0], 404);
  // Equipe de fora convida a Ana: aceitar não muda a principal dela.
  const [, fora] = await teams("create", { name: "Principal Fora", tag: "PFO" }, dono.cookie);
  await teams("invite", { teamId: fora.team.id, name: "Ana Principal" }, dono.cookie);
  const [, inbox] = await teams("get", {}, ana.cookie);
  await teams("accept", { inviteId: inbox.invites[0].id }, ana.cookie);
  const [, comTres] = await teams("get", {}, ana.cookie);
  assert.equal(comTres.teams.filter(t => t.primary).length, 1, "só uma principal");
  assert.equal(comTres.teams.find(t => t.id === segunda.team.id).primary, true);
  // Saindo da principal, a participação mais antiga assume.
  assert.equal((await teams("leave", { teamId: segunda.team.id }, ana.cookie))[0], 409, "capitã não sai; apaga");
  assert.equal((await teams("delete", { teamId: segunda.team.id }, ana.cookie))[0], 200);
  const [, final] = await teams("get", {}, ana.cookie);
  assert.equal(final.teams.filter(t => t.primary).length, 1, "a exclusão da principal promove outra");
  assert.equal(final.teams.find(t => t.id === primeira.team.id).primary, true);
});

test("equipe cheia não aceita mais ninguém (limite configurável)", async () => {
  const ana = await velejador("Ana Lotada");
  const beto = await velejador("Beto Lotado");
  const carla = await velejador("Carla De Fora");
  const [, time] = await teams("create", { name: "Equipe Lotada", tag: "LOT" }, ana.cookie, tightBase);
  const teamId = time.team.id;
  const [, link] = await teams("invite-link", { teamId, uses: 5 }, ana.cookie, tightBase);
  assert.equal((await teams("join-link", { token: link.token }, beto.cookie, tightBase))[0], 200);
  assert.equal((await teams("join-link", { token: link.token }, carla.cookie, tightBase))[0], 409, "equipe cheia");
  const [, lista] = await teams("get", {}, ana.cookie, tightBase);
  assert.equal(lista.teams[0].members.length, 2);
  assert.equal(lista.memberLimit, 2, "o limite vai para o cliente");
});

// --- chat ------------------------------------------------------------------------------------

test("chat: só membros leem e enviam; a mensagem leva nome e avatar", async () => {
  const ana = await velejador("Ana Chat", { emoji: "🐬" });
  const beto = await velejador("Beto Chat");
  const carla = await velejador("Carla De Fora Chat");
  const [, time] = await teams("create", { name: "Equipe Chat", tag: "CHT" }, ana.cookie);
  const teamId = time.team.id;
  const [, link] = await teams("invite-link", { teamId }, ana.cookie);
  await teams("join-link", { token: link.token }, beto.cookie);
  const [s1, enviada] = await teams("send", { teamId, body: "  Boa tarde, tripulação!  " }, ana.cookie);
  assert.equal(s1, 200);
  assert.equal(enviada.message.body, "Boa tarde, tripulação!", "apara as pontas");
  assert.equal((await teams("send", { teamId, body: "eu não sou da equipe" }, carla.cookie))[0], 404);
  assert.equal((await teams("chat", { teamId }, carla.cookie))[0], 404, "de fora não lê");
  const [, chat] = await teams("chat", { teamId }, beto.cookie);
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].user.name, "Ana Chat");
  assert.deepEqual(chat.messages[0].user.avatar, { type: "emoji", emoji: "🐬" });
  assert.equal(chat.messages[0].mine, false);
});

test("chat: validação do texto e limite de taxa", async () => {
  const ana = await velejador("Ana Texto");
  const [, time] = await teams("create", { name: "Equipe Texto", tag: "TXT" }, ana.cookie);
  const teamId = time.team.id;
  assert.equal((await teams("send", { teamId, body: "" }, ana.cookie))[0], 400);
  assert.equal((await teams("send", { teamId, body: "   " }, ana.cookie))[0], 400);
  assert.equal((await teams("send", { teamId, body: "x".repeat(501) }, ana.cookie))[0], 400);
  assert.equal((await teams("send", { teamId, body: "linha\nnova" }, ana.cookie))[0], 400, "sem quebra de linha");
  assert.equal((await teams("send", { teamId, body: 42 }, ana.cookie))[0], 400);
  assert.equal((await teams("send", { teamId, body: "uma" }, ana.cookie, tightBase))[0], 200);
  assert.equal((await teams("send", { teamId, body: "duas" }, ana.cookie, tightBase))[0], 200);
  assert.equal((await teams("send", { teamId, body: "três" }, ana.cookie, tightBase))[0], 429, "limite por minuto");
});

test("chat: histórico paginado por before e polling por after", async () => {
  const ana = await velejador("Ana Historico");
  const [, time] = await teams("create", { name: "Equipe Historico", tag: "HST" }, ana.cookie);
  const teamId = time.team.id;
  for (let i = 1; i <= 5; i++) await teams("send", { teamId, body: `mensagem ${i}` }, ana.cookie);
  const [, primeira] = await teams("chat", { teamId, limit: 2 }, ana.cookie);
  assert.deepEqual(primeira.messages.map(m => m.body), ["mensagem 4", "mensagem 5"], "última página em ordem");
  assert.equal(primeira.hasMore, true);
  const [, anterior] = await teams("chat", { teamId, limit: 2, before: primeira.messages[0].id }, ana.cookie);
  assert.deepEqual(anterior.messages.map(m => m.body), ["mensagem 2", "mensagem 3"]);
  const [, novas] = await teams("chat", { teamId, after: primeira.messages[1].id }, ana.cookie);
  assert.equal(novas.messages.length, 0, "nada novo depois da última");
  await teams("send", { teamId, body: "mensagem 6" }, ana.cookie);
  const [, polling] = await teams("chat", { teamId, after: primeira.messages[1].id }, ana.cookie);
  assert.deepEqual(polling.messages.map(m => m.body), ["mensagem 6"], "polling traz só o que veio depois");
  assert.equal((await teams("chat", { teamId, limit: 0 }, ana.cookie))[0], 400);
  assert.equal((await teams("chat", { teamId, limit: 101 }, ana.cookie))[0], 400);
  assert.equal((await teams("chat", { teamId, before: 1, after: 1 }, ana.cookie))[0], 400);
  assert.equal((await teams("chat", { teamId, before: "abc" }, ana.cookie))[0], 400);
});

test("apagar mensagem: o autor apaga a sua, o capitão apaga qualquer uma, vira tombstone", async () => {
  const ana = await velejador("Ana Modera");
  const beto = await velejador("Beto Modera");
  const [, time] = await teams("create", { name: "Equipe Modera", tag: "MOD" }, ana.cookie);
  const teamId = time.team.id;
  const [, link] = await teams("invite-link", { teamId }, ana.cookie);
  await teams("join-link", { token: link.token }, beto.cookie);
  const [, daAna] = await teams("send", { teamId, body: "mensagem da capitã" }, ana.cookie);
  const [, doBeto] = await teams("send", { teamId, body: "mensagem do Beto" }, beto.cookie);
  assert.equal((await teams("delete-message", { teamId, messageId: daAna.message.id }, beto.cookie))[0], 403, "membro não apaga a dos outros");
  assert.equal((await teams("delete-message", { teamId, messageId: doBeto.message.id }, beto.cookie))[0], 200, "autor apaga a sua");
  assert.equal((await teams("delete-message", { teamId, messageId: daAna.message.id }, ana.cookie))[0], 200, "capitão apaga a própria");
  const [, doBeto2] = await teams("send", { teamId, body: "segunda do Beto" }, beto.cookie);
  assert.equal((await teams("delete-message", { teamId, messageId: doBeto2.message.id }, ana.cookie))[0], 200, "capitão apaga a dos outros");
  assert.equal((await teams("delete-message", { teamId, messageId: doBeto2.message.id }, ana.cookie))[0], 404, "já apagada");
  const [, chat] = await teams("chat", { teamId }, beto.cookie);
  assert.equal(chat.messages.length, 3, "tombstones mantêm a ordem do histórico");
  assert.ok(chat.messages.every(m => m.deleted === true && m.body === ""), "corpo some do banco e da tela");
  const { rows } = await pool.query("SELECT body FROM team_messages WHERE team_id=$1", [teamId]);
  assert.ok(rows.every(r => r.body === ""), "o texto não fica gravado depois de apagado");
});

test("denúncia guarda a cópia do texto e o motivo, uma por mensagem por pessoa", async () => {
  const ana = await velejador("Ana Denuncia");
  const beto = await velejador("Beto Denunciado");
  const carla = await velejador("Carla De Fora Denuncia");
  const [, time] = await teams("create", { name: "Equipe Denuncia", tag: "DNC" }, ana.cookie);
  const teamId = time.team.id;
  const [, link] = await teams("invite-link", { teamId }, ana.cookie);
  await teams("join-link", { token: link.token }, beto.cookie);
  const [, msg] = await teams("send", { teamId, body: "mensagem questionável" }, beto.cookie);
  assert.equal((await teams("report", { teamId, messageId: msg.message.id, reason: "" }, ana.cookie))[0], 400, "sem motivo");
  assert.equal((await teams("report", { teamId, messageId: msg.message.id, reason: "r".repeat(201) }, ana.cookie))[0], 400, "motivo longo");
  assert.equal((await teams("report", { teamId, messageId: msg.message.id, reason: "ofensa" }, carla.cookie))[0], 404, "de fora não denuncia");
  assert.equal((await teams("report", { teamId, messageId: 999999, reason: "ofensa" }, ana.cookie))[0], 404, "mensagem inexistente");
  const [status, body] = await teams("report", { teamId, messageId: msg.message.id, reason: "ofensa ao time" }, ana.cookie);
  assert.equal(status, 200);
  assert.match(body.message, /moderação/i);
  assert.equal((await teams("report", { teamId, messageId: msg.message.id, reason: "de novo" }, ana.cookie))[0], 409, "uma denúncia por pessoa");
  // A denúncia guarda a cópia mesmo depois de a mensagem virar tombstone.
  await teams("delete-message", { teamId, messageId: msg.message.id }, ana.cookie);
  const { rows } = await pool.query("SELECT * FROM team_message_reports WHERE team_id=$1", [teamId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].excerpt, "mensagem questionável");
  assert.equal(rows[0].reason, "ofensa ao time");
  assert.equal(rows[0].reported_user, beto.id);
  assert.equal(rows[0].status, "open");
});

test("limite de denúncias por hora (configurável)", async () => {
  const ana = await velejador("Ana Denuncia Muito");
  const [, time] = await teams("create", { name: "Equipe Denuncia Muito", tag: "DN2" }, ana.cookie, tightBase);
  const teamId = time.team.id;
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const [, msg] = await teams("send", { teamId, body: `mensagem ${i}` }, ana.cookie, tightBase);
    ids.push(msg.message.id);
  }
  assert.equal((await teams("report", { teamId, messageId: ids[0], reason: "motivo um" }, ana.cookie, tightBase))[0], 200);
  assert.equal((await teams("report", { teamId, messageId: ids[1], reason: "motivo dois" }, ana.cookie, tightBase))[0], 200);
  // A terceira denúncia estoura o limite antes mesmo da verificação de repetição.
  assert.equal((await teams("report", { teamId, messageId: ids[0], reason: "motivo três" }, ana.cookie, tightBase))[0], 429);
});

test("mensagens de quem saiu da equipe continuam no histórico com o nome", async () => {
  const ana = await velejador("Ana Historia");
  const beto = await velejador("Beto Passageiro");
  const [, time] = await teams("create", { name: "Equipe Historia", tag: "HIS" }, ana.cookie);
  const teamId = time.team.id;
  const [, link] = await teams("invite-link", { teamId }, ana.cookie);
  await teams("join-link", { token: link.token }, beto.cookie);
  await teams("send", { teamId, body: "fui feliz aqui" }, beto.cookie);
  await teams("leave", { teamId }, beto.cookie);
  const [, chat] = await teams("chat", { teamId }, ana.cookie);
  assert.equal(chat.messages[0].user.name, "Beto Passageiro");
  assert.equal(chat.messages[0].mine, false);
});
