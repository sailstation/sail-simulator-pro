// Testes da carreira (ADR-0008, issues #35/#36): catálogo de classes nos dois níveis, livro-
// razão de pontos só de acréscimo, provas, licenças com concessão automática, elegibilidade de
// salas ranqueadas e resultado de sala encerrada pelo anfitrião — contra PostgreSQL real.
// Requer DATABASE_URL (use scripts/pg-test.sh).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { migrate } from "./db.mjs";
import { createApp } from "./main.mjs";
import { createAuthApi, LIMITS } from "./auth.mjs";
import { createCareerApi, CLASSES, LICENSES, RACE_MILESTONES, achievementName } from "./career.mjs";
import { createPow, leadingZeroBits } from "./pow.mjs";
import { createTestSchema } from "../scripts/testdb.mjs";

let testdb, pool, server, base, openServer, openBase, tableServer, tableBase;

before(async () => {
  testdb = await createTestSchema();
  pool = testdb.pool;
  await migrate(pool);
  const pow = createPow({ secret: "segredo-carreira", bits: 2 });
  const auth = createAuthApi(pool, {
    mail: { send: async () => {} }, pow, testMode: true, scryptParams: { N: 1024, r: 8, p: 1 },
    limits: { ...LIMITS, signupIp: { ...LIMITS.signupIp, max: 1000 } }
  });
  server = createApp({ pool, deployInfo: "{}", auth });
  server.listen(0, "127.0.0.1");
  // Login desligado: a API de carreira continua exigindo sessão (como perfil e equipes).
  openServer = createApp({ pool, deployInfo: "{}", auth, loginRequired: false });
  openServer.listen(0, "127.0.0.1");
  // Tabela de pontos configurável (ADR-0008): todo classificado leva 7 pontos.
  tableServer = createApp({ pool, deployInfo: "{}", auth,
    career: createCareerApi(pool, { pointsFor: () => 7 }) });
  tableServer.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(openServer, "listening"), once(tableServer, "listening")]);
  base = `http://127.0.0.1:${server.address().port}`;
  openBase = `http://127.0.0.1:${openServer.address().port}`;
  tableBase = `http://127.0.0.1:${tableServer.address().port}`;
});

after(async () => {
  server.close();
  openServer.close();
  tableServer.close();
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
const career = (action, body, cookie, app = base) => post(`${app}/api/career/${action}`, body, cookie);
const rooms = (action, body, cookie, app = base) => post(`${app}/api/rooms/${action}`, body, cookie);

const solvePow = ({ challenge, signature }) => {
  const bits = Number(challenge.split(".")[2]);
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(createHash("sha256").update(`${challenge}.${nonce}`).digest()) >= bits) return { challenge, signature, nonce };
  }
};
let accountSeq = 0;
async function velejador(name) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${++accountSeq}@exemplo.com`;
  const [, challenge] = await post(`${base}/api/auth/challenge`, {});
  assert.equal((await post(`${base}/api/auth/signup`, { email, password: "senha-do-velejador", pow: solvePow(challenge) }))[0], 200);
  assert.equal((await post(`${base}/api/auth/test-confirm`, { email }))[0], 200);
  const [status, , r] = await post(`${base}/api/auth/login`, { email, password: "senha-do-velejador" });
  assert.equal(status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.equal((await post(`${base}/api/profile/save`, { name, country: "BR", clubId: "seed-icrj" }, cookie))[0], 200);
  const [, me] = await post(`${base}/api/profile/get`, {}, cookie);
  return { cookie, email, name, id: me.you };
}

const settings = { venue: "central", boatClass: "star", sky: "mixed",
  weather: { wind: 11, gust: 14, dir: 145, wave: .48, waveDir: 155, period: 7, tide: .15, tideRate: .11, current: .2, currentDir: 65 } };
const boat = () => Object.fromEntries(
  "x y h vx vy speed waterSpeed heel pitch heave rudderAngle downSide stage main jib mainAngle jibAngle crewPose extraHike"
    .split(" ").map(k => [k, 0]));

// Corrida completa entre dois velejadores: cria a sala, larga, sincroniza chegadas e encerra.
// `finishes` mapeia índice do participante (0 = anfitrião) para o tempo de chegada (s);
// participante sem tempo não cruza a linha.
async function correr(host, guest, roomSettings, finishes, app = base) {
  const [s1, sala] = await rooms("create", { name: host.name, settings: roomSettings }, host.cookie, app);
  assert.equal(s1, 200);
  let guestRoom = null;
  if (guest) {
    const [s2, g] = await rooms("join", { code: sala.code, name: guest.name }, guest.cookie, app);
    assert.equal(s2, 200);
    guestRoom = g;
  }
  assert.equal((await rooms("start", { code: sala.code, token: sala.token }, host.cookie, app))[0], 200);
  const tokens = [sala.token, guestRoom?.token];
  for (const [index, finish] of Object.entries(finishes)) {
    if (finish === null) continue;
    const [s3] = await rooms("sync", { code: sala.code, token: tokens[index], boat: { ...boat(), finish } }, host.cookie, app);
    assert.equal(s3, 200);
  }
  const [s4, encerrada] = await rooms("finish", { code: sala.code, token: sala.token }, host.cookie, app);
  return [s4, encerrada, sala];
}

// --- acesso ----------------------------------------------------------------------------------

test("sem sessão a API de carreira responde 401, mesmo com o login desligado", async () => {
  assert.equal((await career("get", {}))[0], 401);
  assert.equal((await career("eligible", { boatClass: "star" }))[0], 401);
  assert.equal((await career("achievement", { achievement: "regata-limpa" }))[0], 401);
  assert.equal((await post(`${openBase}/api/career/get`, {}))[0], 401, "login desligado não cria sessão");
});

test("perfil incompleto responde 403 em qualquer ação de carreira", async () => {
  const email = `sem-perfil-${++accountSeq}@exemplo.com`;
  const [, challenge] = await post(`${base}/api/auth/challenge`, {});
  await post(`${base}/api/auth/signup`, { email, password: "senha-do-velejador", pow: solvePow(challenge) });
  await post(`${base}/api/auth/test-confirm`, { email });
  const [, , r] = await post(`${base}/api/auth/login`, { email, password: "senha-do-velejador" });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  assert.equal((await career("get", {}, cookie))[0], 403);
  assert.equal((await career("eligible", { boatClass: "star" }, cookie))[0], 403);
});

test("ação desconhecida responde 404", async () => {
  const ana = await velejador("Ana Rota");
  assert.equal((await career("voar", {}, ana.cookie))[0], 404);
});

// --- catálogo e consulta -----------------------------------------------------------------------

test("catálogo tem as 7 classes iniciais e as 8 avançadas, com 420, Lightning e Star nos dois níveis", () => {
  const iniciais = CLASSES.filter(c => c.tiers.includes("inicial")).map(c => c.id).sort();
  const avancadas = CLASSES.filter(c => c.tiers.includes("avancada")).map(c => c.id).sort();
  assert.deepEqual(iniciais, ["420", "hobiecat", "laser", "lightning", "optimist", "snipe", "star"]);
  assert.deepEqual(avancadas, ["29er", "420", "49er", "j24", "lightning", "nacra17", "sailgp", "star"]);
  for (const id of ["420", "lightning", "star"]) {
    const cls = CLASSES.find(c => c.id === id);
    assert.deepEqual(cls.tiers, ["inicial", "avancada"], `${id} nos dois níveis`);
    assert.ok(cls.license, `${id} exige licença na categoria avançada`);
  }
  assert.equal(LICENSES[0].id, "iniciante");
  assert.equal(LICENSES[0].minPoints, 0);
});

test("carreira nasce com a licença Iniciante, zero pontos e classes iniciais liberadas", async () => {
  const ana = await velejador("Ana Estreante");
  const [status, data] = await career("get", {}, ana.cookie);
  assert.equal(status, 200);
  assert.equal(data.points, 0);
  assert.deepEqual(data.license, { id: "iniciante", name: "Iniciante" });
  assert.equal(data.licenses[0].granted, true, "Iniciante é o ponto de partida");
  assert.equal(data.licenses[1].granted, false);
  const porId = Object.fromEntries(data.classes.map(c => [c.id, c]));
  assert.equal(porId.optimist.unlocked, true);
  assert.equal(porId.star.unlocked, true, "Star é livre no nível inicial");
  assert.equal(porId.star.requires, "clube", "a categoria avançada do Star exige Clube");
  assert.equal(porId["49er"].unlocked, false, "classe puramente avançada bloqueada");
  assert.equal(porId["49er"].requires, "nacional");
  assert.ok(data.classes.every(c => c.licensing === "a verificar"), "licenciamento marcado a verificar");
  assert.deepEqual(data.history, []);
});

// --- provas (achievements) ---------------------------------------------------------------------

test("reporte de prova: tutorial de classe do catálogo e regata limpa, marcados como do cliente", async () => {
  const ana = await velejador("Ana Prova");
  const [status, data] = await career("achievement", { achievement: "tutorial:optimist" }, ana.cookie);
  assert.equal(status, 200);
  assert.equal(data.verification, "client");
  assert.equal(data.already, false);
  assert.equal((await career("achievement", { achievement: "tutorial:optimist" }, ana.cookie))[1].already, true, "idempotente");
  assert.equal((await career("achievement", { achievement: "regata-limpa" }, ana.cookie))[0], 200);
  const [, carreira] = await career("get", {}, ana.cookie);
  assert.deepEqual(carreira.achievements.map(a => a.id).sort(), ["regata-limpa", "tutorial:optimist"]);
  assert.ok(carreira.achievements.every(a => a.verification === "client"));
});

test("prova desconhecida ou não reportável é recusada", async () => {
  const ana = await velejador("Ana Limite");
  assert.equal((await career("achievement", { achievement: "regatas:3" }, ana.cookie))[0], 400, "marco de regatas não é reportável");
  assert.equal((await career("achievement", { achievement: "tutorial:xwing" }, ana.cookie))[0], 400, "classe fora do catálogo");
  assert.equal((await career("achievement", { achievement: "qualquer" }, ana.cookie))[0], 400);
  assert.equal((await career("achievement", {}, ana.cookie))[0], 400);
});

test("nomes de exibição das provas", () => {
  assert.equal(achievementName("tutorial:optimist"), "Tutorial: Optimist");
  assert.equal(achievementName("regatas:10"), "10 regatas completas no modo Avançado");
  assert.equal(achievementName("regata-limpa"), "Regata sem penalidade");
});

// --- elegibilidade -----------------------------------------------------------------------------

test("elegibilidade: sala aberta não exige nada; ranqueada de classe avançada exige a licença", async () => {
  const ana = await velejador("Ana Gate");
  const [, aberta] = await career("eligible", { boatClass: "star", mode: "iniciante" }, ana.cookie);
  assert.equal(aberta.allowed, true, "Star no modo Iniciante é livre");
  const [, semModo] = await career("eligible", { boatClass: "star" }, ana.cookie);
  assert.equal(semModo.allowed, true, "sem modo, vale o padrão aberto");
  const [, ranqueada] = await career("eligible", { boatClass: "star", mode: "avancado" }, ana.cookie);
  assert.equal(ranqueada.allowed, false);
  assert.equal(ranqueada.requires, "clube");
  assert.equal(ranqueada.requiresName, "Clube");
  assert.equal(ranqueada.missing.points, 30);
  assert.deepEqual(ranqueada.missing.achievements.map(a => a.id), ["tutorial:optimist", "regatas:3"]);
  const [, inicial] = await career("eligible", { boatClass: "optimist", mode: "avancado" }, ana.cookie);
  assert.equal(inicial.allowed, true, "classe sem categoria avançada corre no Avançado sem licença");
  const [, legada] = await career("eligible", { boatClass: "tp52", mode: "avancado" }, ana.cookie);
  assert.equal(legada.allowed, true, "raia fora do catálogo não é gated");
  assert.equal((await career("eligible", { boatClass: "star", mode: "dificil" }, ana.cookie))[0], 400);
  assert.equal((await career("eligible", {}, ana.cookie))[0], 400);
});

test("criar e entrar em sala ranqueada de classe avançada exige a licença; sala aberta segue livre", async () => {
  const ana = await velejador("Ana Sala");
  const beto = await velejador("Beto Sala");
  assert.equal((await rooms("create", { name: "Ana", settings: { ...settings, mode: "avancado" } }, ana.cookie))[0], 403,
    "iniciante não cria sala ranqueada de Star");
  const [s1, aberta] = await rooms("create", { name: "Ana", settings }, ana.cookie);
  assert.equal(s1, 200, "sala aberta de Star aceita");
  assert.equal(aberta.settings.mode, "iniciante", "modo padrão é iniciante");
  // Anfitriã licenciada cria a sala ranqueada; o convidado iniciante não entra.
  await pool.query("INSERT INTO point_entries(user_id,points,source,reason,verification,created) VALUES($1,30,'adjustment','bonificação de teste','server',$2)", [ana.id, Date.now()]);
  await career("achievement", { achievement: "tutorial:optimist" }, ana.cookie);
  await pool.query("INSERT INTO achievements(user_id,achievement,source,verification,created) VALUES($1,'regatas:3','room','client',$2)", [ana.id, Date.now()]);
  await career("get", {}, ana.cookie); // a consulta reavalia a escada e concede a licença
  const [, carreira] = await career("get", {}, ana.cookie);
  assert.equal(carreira.license.id, "clube");
  const [s2, ranqueada] = await rooms("create", { name: "Ana", settings: { ...settings, mode: "avancado" } }, ana.cookie);
  assert.equal(s2, 200, "licenciada cria sala ranqueada");
  assert.equal(ranqueada.settings.mode, "avancado");
  const [s3, negado] = await rooms("join", { code: ranqueada.code, name: "Beto" }, beto.cookie);
  assert.equal(s3, 403);
  assert.match(negado.error, /licença Clube/);
  assert.equal((await rooms("join", { code: aberta.code, name: "Beto" }, beto.cookie))[0], 200, "sala aberta aceita o iniciante");
  const [, eleg] = await career("eligible", { boatClass: "star", mode: "avancado" }, beto.cookie);
  assert.equal(eleg.allowed, false);
  await career("achievement", { achievement: "tutorial:optimist" }, beto.cookie);
  await pool.query("INSERT INTO point_entries(user_id,points,source,reason,verification,created) VALUES($1,30,'adjustment','bonificação de teste','server',$2)", [beto.id, Date.now()]);
  await pool.query("INSERT INTO achievements(user_id,achievement,source,verification,created) VALUES($1,'regatas:3','room','client',$2)", [beto.id, Date.now()]);
  await career("get", {}, beto.cookie);
  assert.equal((await rooms("join", { code: ranqueada.code, name: "Beto" }, beto.cookie))[0], 200, "com a licença, entra");
});

test("modo inválido nas configurações da sala é recusado", async () => {
  const ana = await velejador("Ana Modo");
  assert.equal((await rooms("create", { name: "Ana", settings: { ...settings, mode: "dificil" } }, ana.cookie))[0], 400);
});

// --- resultado de sala e pontos ------------------------------------------------------------------

test("encerrar regata avançada: posições por tempo, pontos por posição e flotilha, extrato e marco de regata", async () => {
  const ana = await velejador("Ana Regata");
  const beto = await velejador("Beto Regata");
  const avancada = { ...settings, boatClass: "optimist", mode: "avancado" };
  const [status, encerrada] = await correr(ana, beto, avancada, { 0: 100.5, 1: 120 });
  assert.equal(status, 200);
  assert.equal(encerrada.ranked, true);
  assert.equal(typeof encerrada.finished, "number");
  assert.deepEqual(encerrada.results.map(r => [r.name, r.position, r.points]),
    [["Ana Regata", 1, 2], ["Beto Regata", 2, 1]], "vencedora leva N pontos, último leva 1");
  const [, carreira] = await career("get", {}, ana.cookie);
  assert.equal(carreira.points, 2);
  assert.equal(carreira.history.length, 1);
  assert.equal(carreira.history[0].source, "room");
  assert.equal(carreira.history[0].verification, "client", "pontos de origem cliente ficam marcados");
  assert.match(carreira.history[0].reason, /P1/);
  assert.deepEqual(carreira.achievements.map(a => a.id), ["regatas:1"], "marco de primeira regata");
  const { rows } = await pool.query("SELECT verification, humans, mode FROM room_results WHERE room=$1", [encerrada.code]);
  assert.deepEqual(rows, [{ verification: "client", humans: 2, mode: "avancado" }]);
});

test("sala iniciante registra o resultado mas não pontua; solo no Avançado também não", async () => {
  const ana = await velejador("Ana Amistosa");
  const beto = await velejador("Beto Amistoso");
  const [s1, aberta] = await correr(ana, beto, { ...settings, boatClass: "optimist" }, { 0: 90, 1: 95 });
  assert.equal(s1, 200);
  assert.equal(aberta.ranked, false);
  assert.deepEqual(aberta.results.map(r => r.points), [0, 0]);
  assert.equal((await career("get", {}, ana.cookie))[1].points, 0, "modo Iniciante não pontua");
  assert.equal((await career("get", {}, ana.cookie))[1].achievements.length, 0, "regata no Iniciante não conta marco");
  const [s2, solo] = await correr(ana, null, { ...settings, boatClass: "optimist", mode: "avancado" }, { 0: 80 });
  assert.equal(s2, 200);
  assert.equal(solo.ranked, false, "menos de 2 participantes não pontua");
  assert.equal((await career("get", {}, ana.cookie))[1].points, 0);
});

test("quem não cruza a linha fica sem posição e sem pontos", async () => {
  const ana = await velejador("Ana Chegada");
  const beto = await velejador("Beto Abandono");
  const [status, encerrada] = await correr(ana, beto, { ...settings, boatClass: "optimist", mode: "avancado" }, { 0: 75, 1: null });
  assert.equal(status, 200);
  assert.deepEqual(encerrada.results.map(r => [r.position, r.points]), [[1, 1], [null, 0]],
    "flotilha de 1 classificado: vencedora leva 1");
  assert.equal((await career("get", {}, beto.cookie))[1].points, 0);
});

test("encerramento: só o anfitrião, só depois da largada, e uma única vez", async () => {
  const ana = await velejador("Ana Apito");
  const beto = await velejador("Beto Cedo");
  const [s1, sala] = await rooms("create", { name: "Ana", settings: { ...settings, boatClass: "optimist" } }, ana.cookie);
  assert.equal(s1, 200);
  const [, guest] = await rooms("join", { code: sala.code, name: "Beto" }, beto.cookie);
  assert.equal((await rooms("finish", { code: sala.code, token: sala.token }, ana.cookie))[0], 409, "antes da largada");
  await rooms("start", { code: sala.code, token: sala.token }, ana.cookie);
  assert.equal((await rooms("finish", { code: sala.code, token: guest.token }, beto.cookie))[0], 403, "convidado não encerra");
  assert.equal((await rooms("finish", { code: sala.code, token: sala.token }, ana.cookie))[0], 200);
  assert.equal((await rooms("finish", { code: sala.code, token: sala.token }, ana.cookie))[0], 409, "encerramento único");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM room_results WHERE room=$1", [sala.code]);
  assert.equal(rows[0].n, 1);
});

test("tabela de pontos é configurável", async () => {
  const ana = await velejador("Ana Tabela");
  const beto = await velejador("Beto Tabela");
  const [status, encerrada] = await correr(ana, beto, { ...settings, boatClass: "optimist", mode: "avancado" }, { 0: 60, 1: 70 }, tableBase);
  assert.equal(status, 200);
  assert.deepEqual(encerrada.results.map(r => r.points), [7, 7], "pointsFor injetado vale 7 para todos");
});

// --- licenças ------------------------------------------------------------------------------------

test("escada de licenças: concessão automática ao cumprir pontos e provas, degraus em ordem", async () => {
  const ana = await velejador("Ana Escada");
  const at = Date.now();
  await pool.query("INSERT INTO point_entries(user_id,points,source,reason,verification,created) VALUES($1,120,'adjustment','bonificação de teste','server',$2)", [ana.id, at]);
  await career("achievement", { achievement: "tutorial:optimist" }, ana.cookie);
  await career("achievement", { achievement: "tutorial:laser" }, ana.cookie);
  await career("achievement", { achievement: "regata-limpa" }, ana.cookie);
  // Como no fluxo real: completar 10 regatas grava todos os marcos até 10.
  for (const marco of [1, 3, 5, 10]) {
    await pool.query("INSERT INTO achievements(user_id,achievement,source,verification,created) VALUES($1,$2,'room','client',$3)", [ana.id, `regatas:${marco}`, at]);
  }
  const [, carreira] = await career("get", {}, ana.cookie);
  assert.equal(carreira.license.id, "nacional", "120 pontos e as provas de Clube e Nacional");
  const porId = Object.fromEntries(carreira.licenses.map(l => [l.id, l]));
  assert.equal(porId.clube.granted, true);
  assert.equal(porId.nacional.granted, true);
  assert.equal(porId.internacional.granted, false);
  assert.equal(porId.internacional.achievements.find(a => a.id === "tutorial:lightning").done, false);
  const porClasse = Object.fromEntries(carreira.classes.map(c => [c.id, c]));
  assert.equal(porClasse["49er"].unlocked, true, "classe avançada libera com a licença");
  assert.equal(porClasse.nacra17.unlocked, false);
  assert.equal((await career("eligible", { boatClass: "star", mode: "avancado" }, ana.cookie))[1].allowed, true);
});

test("queda de saldo não revoga licença registrada; ajuste manual entra no extrato", async () => {
  const ana = await velejador("Ana Queda");
  const at = Date.now();
  await pool.query("INSERT INTO point_entries(user_id,points,source,reason,verification,created) VALUES($1,30,'adjustment','bonificação de teste','server',$2)", [ana.id, at]);
  await career("achievement", { achievement: "tutorial:optimist" }, ana.cookie);
  await pool.query("INSERT INTO achievements(user_id,achievement,source,verification,created) VALUES($1,'regatas:3','room','client',$2)", [ana.id, at]);
  await career("get", {}, ana.cookie);
  await pool.query("INSERT INTO point_entries(user_id,points,source,reason,verification,created) VALUES($1,-25,'adjustment','correção de moderação','server',$2)", [ana.id, at]);
  const [, carreira] = await career("get", {}, ana.cookie);
  assert.equal(carreira.points, 5, "saldo é a soma dos lançamentos");
  assert.equal(carreira.license.id, "clube", "licença conquistada não se perde (estilo ACC)");
  assert.ok(carreira.history.some(l => l.source === "adjustment" && l.points === -25), "ajuste aparece no extrato");
});

test("marcos de regatas acumulam entre salas e o livro-razão nunca é reescrito", async () => {
  const ana = await velejador("Ana Marina");
  const beto = await velejador("Beto Marina");
  const avancada = { ...settings, boatClass: "optimist", mode: "avancado" };
  for (let i = 0; i < 3; i++) {
    const [status] = await correr(ana, beto, avancada, { 0: 50 + i, 1: 60 + i });
    assert.equal(status, 200);
  }
  const [, carreira] = await career("get", {}, ana.cookie);
  assert.equal(carreira.points, 6, "3 vitórias com flotilha de 2");
  assert.deepEqual(carreira.achievements.map(a => a.id).sort(), ["regatas:1", "regatas:3"]);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM point_entries WHERE user_id=$1", [ana.id]);
  assert.equal(rows[0].n, 3, "um lançamento por regata — nada de UPDATE em saldo");
});

test("constantes do domínio coerentes: marcos incluem os exigidos pelas licenças", () => {
  for (const license of LICENSES) {
    for (const id of license.achievements) {
      const regatas = /^regatas:(\d+)$/.exec(id);
      if (regatas) assert.ok(RACE_MILESTONES.includes(Number(regatas[1])), `${id} é marco computável`);
      const tutorial = /^tutorial:(.+)$/.exec(id);
      if (tutorial) assert.ok(CLASSES.some(c => c.id === tutorial[1]), `${id} é classe do catálogo`);
    }
  }
});
