// Testes da API de salas e do servidor nativo contra PostgreSQL real.
// Requer DATABASE_URL (use scripts/pg-test.sh, que sobe um cluster temporário).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createPool, migrate } from "./db.mjs";
import { createApp, clientIp, loginRequiredFrom } from "./main.mjs";
import { createAuthApi } from "./auth.mjs";
import { createPow, leadingZeroBits } from "./pow.mjs";
import { createTestSchema } from "../scripts/testdb.mjs";

let testdb, pool, server, base, cookie, openServer, openBase;

before(async () => {
  // Esquema próprio e aleatório: a suíte pode repetir contra o mesmo banco (sail_ci).
  testdb = await createTestSchema();
  pool = testdb.pool;
  await migrate(pool);
  const pow = createPow({ secret: "segredo-api", bits: 2 });
  const auth = createAuthApi(pool, {
    mail: { send: async () => {} }, pow, testMode: true, scryptParams: { N: 1024, r: 8, p: 1 }
  });
  server = createApp({ pool, deployInfo: '{"env":"teste"}', auth });
  server.listen(0, "127.0.0.1");
  // Segunda instância com o login desligado (SAIL_LOGIN_REQUIRED=0 ou sem SMTP), para os
  // testes do modo aberto — o modo em que a release sobe na transição do ADR-0005.
  openServer = createApp({ pool, deployInfo: '{"env":"teste"}', auth, loginRequired: false });
  openServer.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(openServer, "listening")]);
  base = `http://127.0.0.1:${server.address().port}`;
  openBase = `http://127.0.0.1:${openServer.address().port}`;
  cookie = await createAccount("anfitria@exemplo.com");
  await completeProfile(cookie);
});

after(async () => {
  server.close();
  openServer.close();
  await testdb.drop();
});

const post = async (path, body, headers = {}) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  });
  const text = await r.text();
  return [r.status, text ? JSON.parse(text) : null, r];
};

// Resolve a prova de trabalho em Node, como o e2e faz.
const solvePow = ({ challenge, signature }) => {
  const bits = Number(challenge.split(".")[2]);
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(createHash("sha256").update(`${challenge}.${nonce}`).digest()) >= bits) return { challenge, signature, nonce };
  }
};

// Cadastro + confirmação (rota de teste) + login; devolve o cookie de sessão.
async function createAccount(email) {
  const [, challenge] = await post("/api/auth/challenge", {});
  assert.equal((await post("/api/auth/signup", { email, password: "senha-da-jogadora", pow: solvePow(challenge) }))[0], 200);
  assert.equal((await post("/api/auth/test-confirm", { email }))[0], 200);
  const [status, , r] = await post("/api/auth/login", { email, password: "senha-da-jogadora" });
  assert.equal(status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}

// PNG 1x1 real (transparente) para completar o perfil (ADR-0006: foto obrigatória para jogar).
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");
async function completeProfile(session, clubId = "seed-icrj") {
  const [saveStatus] = await post("/api/profile/save",
    { name: "Anfitriã", country: "BR", clubId }, { cookie: session });
  assert.equal(saveStatus, 200);
  const foto = await fetch(`${base}/api/profile/photo`, {
    method: "POST", headers: { "content-type": "image/png", cookie: session }, body: PNG_1X1
  });
  assert.equal(foto.status, 200);
}

const call = (action, body, headers = {}) => post(`/api/rooms/${action}`, body, { cookie, ...headers });

const settings = { venue: "central", boatClass: "star", sky: "mixed",
  weather: { wind: 11, gust: 14, dir: 145, wave: .48, waveDir: 155, period: 7, tide: .15, tideRate: .11, current: .2, currentDir: 65 } };
const boat = () => Object.fromEntries(
  "x y h vx vy speed waterSpeed heel pitch heave rudderAngle downSide stage main jib mainAngle jibAngle crewPose extraHike"
    .split(" ").map(k => [k, 0]));

const createRoom = async (extra = {}) => {
  const [status, body] = await call("create", { name: "Anfitriã", settings, ...extra });
  assert.equal(status, 200);
  return body;
};

test("criar sala devolve código, anfitrião na vaga 0 e timestamps numéricos", async () => {
  const room = await createRoom();
  assert.match(room.code, /^[A-Z2-9]{7}$/);
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0].seat, 0);
  assert.equal(room.players[0].name, "Anfitriã");
  assert.equal(room.starts, null);
  assert.equal(typeof room.now, "number");
  assert.equal(typeof room.id, "string");
  assert.equal(typeof room.token, "string");
});

test("condições são normalizadas: Canas fixa o vento em 90°, chuva vira nublado, rajada cobre o vento", async () => {
  const room = await createRoom({ settings: { ...settings, venue: "canas", sky: "rain",
    weather: { ...settings.weather, wind: 20, gust: 5 } } });
  assert.equal(room.settings.venue, "canas");
  assert.equal(room.settings.sky, "cloudy");
  assert.equal(room.settings.weather.dir, 90);
  assert.equal(room.settings.weather.gust, 20);
});

test("criar sala com condições inválidas é recusado", async () => {
  assert.equal((await call("create", { name: "A", settings: { ...settings, venue: "lua" } }))[0], 400);
  assert.equal((await call("create", { name: "A", settings: { ...settings, weather: { ...settings.weather, wind: 999 } } }))[0], 400);
  assert.equal((await call("create", { name: "A" }))[0], 400);
});

test("nome vazio, longo ou com caractere de controle é recusado", async () => {
  assert.equal((await call("create", { name: "   ", settings }))[0], 400);
  assert.equal((await call("create", { name: "x".repeat(25), settings }))[0], 400);
  assert.equal((await call("create", { name: "ab", settings }))[0], 400);
  const long = await call("join", { code: "AAAA222", name: "x".repeat(25) });
  assert.equal(long[0], 400);
});

test("entrar ocupa as vagas 1 a 5 e a sétima pessoa é recusada", async () => {
  const host = await createRoom();
  const seats = [];
  for (let i = 1; i <= 5; i++) {
    const [status, guest] = await call("join", { code: host.code, name: "Conv " + i });
    assert.equal(status, 200);
    seats.push(guest.players.find(p => p.id === guest.id).seat);
  }
  assert.deepEqual(seats, [1, 2, 3, 4, 5]);
  const [status, body] = await call("join", { code: host.code, name: "Extra" });
  assert.equal(status, 409);
  assert.match(body.error, /cheia/);
});

test("código malformado dá 400 e sala inexistente dá 404", async () => {
  assert.equal((await call("join", { code: "xx", name: "A" }))[0], 400);
  assert.equal((await call("join", { code: "AAAA222", name: "A" }))[0], 404);
});

test("convidado não larga; anfitrião larga e o relógio (BIGINT) volta como número", async () => {
  const host = await createRoom();
  const [, guest] = await call("join", { code: host.code, name: "Conv" });
  assert.equal((await call("start", { code: host.code, token: guest.token }))[0], 403);
  const [status, room] = await call("start", { code: host.code, token: host.token });
  assert.equal(status, 200);
  assert.equal(typeof room.starts, "number");
  assert.equal(room.starts - room.now, 8 * 60_000);
  assert.equal((await call("start", { code: host.code, token: host.token }))[0], 409);
  const late = await call("join", { code: host.code, name: "Tarde" });
  assert.equal(late[0], 409);
  assert.match(late[1].error, /já começou/);
});

test("configure ajusta as condições antes da largada e recusa depois dela", async () => {
  const host = await createRoom();
  const novas = { ...settings, sky: "clear" };
  const [status, room] = await call("configure", { code: host.code, token: host.token, settings: novas });
  assert.equal(status, 200);
  assert.equal(room.settings.sky, "clear");
  assert.equal(room.starts, null);
  await call("start", { code: host.code, token: host.token });
  assert.equal((await call("configure", { code: host.code, token: host.token, settings: novas }))[0], 409);
});

test("sync valida a posição, preserva o barco e oculta o token dos demais", async () => {
  const host = await createRoom();
  const [, guest] = await call("join", { code: host.code, name: "Conv" });
  await call("start", { code: host.code, token: host.token });
  const pos = { ...boat(), x: 7, y: -19 };
  assert.equal((await call("sync", { code: host.code, token: guest.token, boat: pos }))[0], 200);
  assert.equal((await call("sync", { code: host.code, token: guest.token, boat: { ...boat(), x: 999999 } }))[0], 400);
  const [, view] = await call("sync", { code: host.code, token: host.token });
  const rec = view.players.find(p => p.id === guest.id);
  assert.equal(rec.boat.x, 7);
  assert.equal(rec.boat.y, -19);
  assert.equal(rec.token, undefined);
  assert.equal(rec.online, true);
  // Sem largada, posição enviada é ignorada, mas a presença conta.
  const solo = await createRoom();
  assert.equal((await call("sync", { code: solo.code, token: solo.token, boat: pos }))[0], 200);
  const [, antes] = await call("sync", { code: solo.code, token: solo.token });
  assert.equal(antes.players[0].boat, null);
});

test("sync valida inventário do Soto 40 e aparelho/proeiro do Star", async () => {
  const host = await createRoom();
  await call("start", { code: host.code, token: host.token });
  const sync = boat => call("sync", { code: host.code, token: host.token, boat });
  assert.equal((await sync({ ...boat(), soto: { jib: 9, spi: 1 } }))[0], 400);
  assert.equal((await sync({ ...boat(), soto: { jib: 2, spi: 1, sheet: 50, ease: 1 } }))[0], 200);
  assert.equal((await sync({ ...boat(), starRig: { outhaul: 2, cunningham: 0, runner: 0 } }))[0], 400);
  assert.equal((await sync({ ...boat(), starRig: { outhaul: .5, cunningham: 0, runner: 0 } }))[0], 200);
  assert.equal((await sync({ ...boat(), starMotion: { stand: 2, fore: 0, side: 0 } }))[0], 400);
  assert.equal((await sync({ ...boat(), starMotion: { stand: .5, fore: -1, side: 1 } }))[0], 200);
  const [, view] = await sync({ ...boat(), finish: 42.5 });
  assert.equal(view.players[0].boat.finish, 42.5);
});

test("sair: convidado libera a vaga; anfitrião antes da largada encerra a sala", async () => {
  const host = await createRoom();
  const [, guest] = await call("join", { code: host.code, name: "Conv" });
  assert.equal((await call("leave", { code: host.code, token: guest.token }))[0], 200);
  const [, view] = await call("sync", { code: host.code, token: host.token });
  assert.equal(view.players.length, 1);
  assert.equal((await call("leave", { code: host.code, token: host.token }))[0], 200);
  assert.equal((await call("sync", { code: host.code, token: host.token }))[0], 404);
});

test("anfitrião que sai depois da largada só libera a própria vaga", async () => {
  const host = await createRoom();
  const [, guest] = await call("join", { code: host.code, name: "Conv" });
  await call("start", { code: host.code, token: host.token });
  assert.equal((await call("leave", { code: host.code, token: host.token }))[0], 200);
  const [status, view] = await call("sync", { code: host.code, token: guest.token });
  assert.equal(status, 200);
  assert.equal(view.players.length, 1);
  assert.equal(view.players[0].id, guest.id);
});

test("sala expirada não aceita entrada e é removida no próximo create", async () => {
  await pool.query("INSERT INTO rooms(code,settings,created,expires) VALUES ('AAA2222','{}',$1,$2)",
    [Date.now() - 10_000, Date.now() - 1_000]);
  assert.equal((await call("join", { code: "AAA2222", name: "A" }))[0], 404);
  await createRoom();
  assert.equal((await pool.query("SELECT 1 FROM rooms WHERE code='AAA2222'")).rowCount, 0);
});

test("convidado inativo há mais de 90 s perde a vaga quando alguém entra", async () => {
  const host = await createRoom();
  await pool.query("INSERT INTO sailors(room,seat,id,token,name,seen) VALUES ($1,3,'fantasma','t-fantasma','Fantasma',$2)",
    [host.code, Date.now() - 100_000]);
  const [status, guest] = await call("join", { code: host.code, name: "Conv" });
  assert.equal(status, 200);
  assert.deepEqual(guest.players.map(p => p.seat), [0, 1]);
});

test("requisições inválidas: método, origem, formato, tamanho, JSON e ação", async () => {
  assert.equal((await fetch(`${base}/api/rooms/create`)).status, 405);
  assert.equal((await call("create", { name: "A", settings }, { origin: "https://outro.site" }))[0], 403);
  assert.equal((await fetch(`${base}/api/rooms/create`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  const grande = await call("create", { name: "x".repeat(5000), settings });
  assert.equal(grande[0], 413);
  assert.match(grande[1].error, /grande/);
  const enorme = await fetch(`${base}/api/rooms/create`, { method: "POST", headers: { "content-type": "application/json" }, body: " ".repeat(70 * 1024) });
  assert.equal(enorme.status, 413);
  const ruim = await fetch(`${base}/api/rooms/create`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(ruim.status, 400);
  assert.equal((await call("create", { name: "A", settings }, { origin: base }))[0], 200);
  const host = await createRoom();
  assert.equal((await call("voar", { code: host.code, token: host.token }))[0], 404);
  assert.equal((await call("sync", { code: host.code, token: "curto" }))[0], 404);
  assert.equal((await call("sync", { code: host.code, token: crypto.randomUUID() }))[0], 404);
});

test("login obrigatório: sem sessão a API de salas responde 401 e o site redireciona para a entrada", async () => {
  const [status, body] = await post("/api/rooms/create", { name: "A", settings });
  assert.equal(status, 401);
  assert.match(body.error, /Entre para jogar/);
  assert.equal((await post("/api/rooms/sync", { code: "AAAA222", token: crypto.randomUUID() }))[0], 401);
  const raiz = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(raiz.status, 302);
  assert.equal(raiz.headers.get("location"), "/login.html");
  assert.equal((await fetch(`${base}/game.js`, { redirect: "manual" })).status, 302);
  const comCookieRuim = await fetch(`${base}/`, { redirect: "manual", headers: { cookie: "sail_session=" + "x".repeat(43) } });
  assert.equal(comCookieRuim.status, 302, "cookie inválido não abre o site");
  // A tela de entrada e os assets dela abrem sem sessão.
  for (const path of ["/login.html", "/login.css", "/login.js", "/sail-simulator-pro-splash.webp"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
  // Depois do login o mesmo caminho abre o site.
  assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 200);
});

test("cabeçalhos de segurança em todas as respostas", async () => {
  for (const path of ["/login.html", "/__deploy"]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("referrer-policy"), "same-origin");
    assert.equal(r.headers.get("strict-transport-security"), "max-age=15552000");
    assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
  }
});

test("login desligado: site e salas abrem sem sessão, como antes do ADR-0005", async () => {
  // A sonda exata do app_healthy do deploy.sh da main na transição: / com sucesso e
  // /api/rooms/sync respondendo 404 (não 401), senão o deploy reverteria a release.
  const raiz = await fetch(`${openBase}/`);
  assert.equal(raiz.status, 200);
  assert.match(raiz.headers.get("cache-control"), /^private/);
  const [syncStatus] = await (async () => {
    const r = await fetch(`${openBase}/api/rooms/sync`, { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"code":"AAAA222","token":"x"}' });
    return [r.status];
  })();
  assert.equal(syncStatus, 404, "sonda do deploy antigo precisa de 404");
  // Salas funcionam sem cookie e a tela de entrada continua acessível, sem bloquear nada.
  const [createStatus, room] = await (async () => {
    const r = await fetch(`${openBase}/api/rooms/create`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Aberta", settings }) });
    return [r.status, await r.json()];
  })();
  assert.equal(createStatus, 200);
  assert.match(room.code, /^[A-Z2-9]{7}$/);
  assert.equal((await fetch(`${openBase}/login.html`)).status, 200);
  const challenge = await fetch(`${openBase}/api/auth/challenge`, { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(challenge.status, 200, "API de contas continua no ar com o login desligado");
});

test("loginRequiredFrom: teste liga sempre; fora dele, a variável manda; padrão segue o SMTP", () => {
  assert.equal(loginRequiredFrom({ SAIL_ENV: "test" }), true, "ambiente de teste liga sempre");
  assert.equal(loginRequiredFrom({ SAIL_ENV: "test", SAIL_LOGIN_REQUIRED: "0" }), true, "nem a variável desliga o teste");
  assert.equal(loginRequiredFrom({ SAIL_ENV: "test", SMTP_HOST: "" }), true, "teste liga mesmo sem SMTP");
  assert.equal(loginRequiredFrom({}), false, "sem SMTP, desligado");
  assert.equal(loginRequiredFrom({ SMTP_HOST: "smtp.coop.br" }), true, "com SMTP, ligado");
  assert.equal(loginRequiredFrom({ SAIL_LOGIN_REQUIRED: "1" }), true);
  assert.equal(loginRequiredFrom({ SAIL_LOGIN_REQUIRED: "0", SMTP_HOST: "smtp.coop.br" }), false, "variável vence o SMTP");
  for (const off of ["0", "false", "off", "no", "OFF"]) {
    assert.equal(loginRequiredFrom({ SAIL_LOGIN_REQUIRED: off }), false, off);
  }
});

test("clientIp: X-Forwarded-For só é confiável vindo do proxy local, e vale o último salto", () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  assert.equal(clientIp(req("127.0.0.1", "203.0.113.9")), "203.0.113.9", "Caddy repassou o cliente");
  assert.equal(clientIp(req("127.0.0.1", "198.51.100.7, 203.0.113.9")), "203.0.113.9",
    "cliente forjou o primeiro valor; o Caddy acrescentou o real no fim");
  assert.equal(clientIp(req("::1", "203.0.113.9")), "203.0.113.9");
  assert.equal(clientIp(req("::ffff:127.0.0.1", "203.0.113.9")), "203.0.113.9");
  assert.equal(clientIp(req("127.0.0.1")), "127.0.0.1", "sem cabeçalho, vale o peer");
  assert.equal(clientIp(req("127.0.0.1", " , ")), "127.0.0.1", "cabeçalho vazio cai no peer");
  assert.equal(clientIp(req("10.0.0.5", "203.0.113.9")), "10.0.0.5", "peer que não é proxy local não é confiável");
});

test("Origin malformado é recusado com 403, não com erro interno", async () => {
  const r = await fetch(`${base}/api/rooms/create`, { method: "POST",
    headers: { "content-type": "application/json", origin: "///nao-e-url" }, body: "{}" });
  assert.equal(r.status, 403);
});

test("logout encerra o acesso ao site e à API", async () => {
  const proprio = await createAccount("sai-fora@exemplo.com");
  await completeProfile(proprio);
  assert.equal((await post("/api/rooms/create", { name: "A", settings }, { cookie: proprio }))[0], 200);
  const [status, , r] = await post("/api/auth/logout", {}, { cookie: proprio });
  assert.equal(status, 200);
  assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await post("/api/rooms/create", { name: "A", settings }, { cookie: proprio }))[0], 401);
});

test("estáticos com sessão: index na raiz, ETag com 304, 404 e /__deploy", async () => {
  const index = await fetch(`${base}/`, { headers: { cookie } });
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  assert.match(await index.text(), /</);
  const js = await fetch(`${base}/game.js`, { headers: { cookie } });
  assert.equal(js.status, 200);
  const etag = js.headers.get("etag");
  assert.ok(etag);
  assert.equal((await fetch(`${base}/game.js`, { headers: { cookie, "if-none-match": etag } })).status, 304);
  const head = await fetch(`${base}/game.js`, { method: "HEAD", headers: { cookie } });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  assert.equal((await fetch(`${base}/nao-existe`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/game.js`, { method: "POST", headers: { cookie } })).status, 404);
  const deploy = await fetch(`${base}/__deploy`);
  assert.equal(deploy.status, 200);
  assert.deepEqual(await deploy.json(), { env: "teste" });
});

test("migrações são idempotentes e ficam registradas em _migrations", async () => {
  await migrate(pool);
  const { rows } = await pool.query("SELECT name FROM _migrations");
  assert.deepEqual(rows.map(r => r.name), ["0000_regatta_rooms.sql", "0001_contas.sql", "0002_perfil.sql"]);
});

test("pool sem DATABASE_URL falha na hora", () => {
  assert.throws(() => createPool(""), /DATABASE_URL/);
});
