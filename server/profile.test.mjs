// Testes do perfil do velejador (ADR-0006): foto, país, clube, gate de completude e busca de clubes,
// contra PostgreSQL real. Requer DATABASE_URL (use scripts/pg-test.sh).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { migrate } from "./db.mjs";
import { createApp } from "./main.mjs";
import { createAuthApi, LIMITS } from "./auth.mjs";
import { createPow, leadingZeroBits } from "./pow.mjs";
import { COUNTRY_CODES } from "./countries.mjs";
import { createTestSchema } from "../scripts/testdb.mjs";
import { jpeg, png, webp, FAKE_GPS } from "../scripts/test-images.mjs";

let testdb, pool, server, base, openServer, openBase;

// PNG 1x1 real (transparente), para uploads que passam na verificação dos bytes iniciais.
// JPEG e WebP sintéticos estruturalmente válidos vêm de scripts/test-images.mjs (ADR-0006:
// o upload agora confere a estrutura inteira para remover metadados, não só os bytes iniciais).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");
const JPEG = jpeg({ metadata: false });
const WEBP = webp({ metadata: false, vp8x: false });

before(async () => {
  testdb = await createTestSchema();
  pool = testdb.pool;
  await migrate(pool);
  const pow = createPow({ secret: "segredo-perfil", bits: 2 });
  const auth = createAuthApi(pool, {
    mail: { send: async () => {} }, pow, testMode: true, scryptParams: { N: 1024, r: 8, p: 1 },
    // A suíte cria mais contas que o limite real de cadastro por IP (ADR-0005); o limite em si
    // é coberto em auth.test.mjs.
    limits: { ...LIMITS, signupIp: { ...LIMITS.signupIp, max: 1000 } }
  });
  server = createApp({ pool, deployInfo: "{}", auth });
  server.listen(0, "127.0.0.1");
  openServer = createApp({ pool, deployInfo: "{}", auth, loginRequired: false });
  openServer.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(openServer, "listening")]);
  base = `http://127.0.0.1:${server.address().port}`;
  openBase = `http://127.0.0.1:${openServer.address().port}`;
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
const profile = (action, body, cookie) => post(`/api/profile/${action}`, body, { cookie });
const upload = (cookie, bytes, type = "image/png") => fetch(`${base}/api/profile/photo`, {
  method: "POST", headers: { "content-type": type, cookie }, body: bytes
});

const solvePow = ({ challenge, signature }) => {
  const bits = Number(challenge.split(".")[2]);
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(createHash("sha256").update(`${challenge}.${nonce}`).digest()) >= bits) return { challenge, signature, nonce };
  }
};
let accountSeq = 0;
async function createAccount(name = "conta") {
  const email = `${name}-${++accountSeq}@exemplo.com`;
  const [, challenge] = await post("/api/auth/challenge", {});
  assert.equal((await post("/api/auth/signup", { email, password: "senha-do-velejador", pow: solvePow(challenge) }))[0], 200);
  assert.equal((await post("/api/auth/test-confirm", { email }))[0], 200);
  const [status, , r] = await post("/api/auth/login", { email, password: "senha-do-velejador" });
  assert.equal(status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
test("avatars: lista curada, com ⛵ presente e sem repetições", async () => {
  const cookie = await createAccount("emojis");
  const [status, body] = await profile("avatars", {}, cookie);
  assert.equal(status, 200);
  assert.ok(body.emojis.includes("⛵"), "o padrão ⛵ está na lista");
  assert.ok(body.emojis.length >= 20 && body.emojis.length <= 30, "lista curta e curada");
  assert.equal(new Set(body.emojis).size, body.emojis.length);
  assert.ok(body.emojis.every(e => typeof e === "string" && e.length > 0));
});

const settings = { venue: "central", boatClass: "star", sky: "mixed",
  weather: { wind: 11, gust: 14, dir: 145, wave: .48, waveDir: 155, period: 7, tide: .15, tideRate: .11, current: .2, currentDir: 65 } };

test("sem sessão, a API de perfil responde 401, mesmo com o login desligado", async () => {
  assert.equal((await profile("get", {}))[0], 401);
  assert.equal((await profile("save", { name: "A", country: "BR", clubId: "seed-icrj" }))[0], 401);
  const r = await fetch(`${openBase}/api/profile/get`, { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401, "login desligado não cria sessão, então não há perfil");
});

test("lista de países: ISO 3166-1 alfa-2 embutida, com BR, PT e códigos únicos de duas letras", async () => {
  const cookie = await createAccount("paises");
  const [status, body] = await profile("countries", {}, cookie);
  assert.equal(status, 200);
  assert.ok(body.countries.includes("BR") && body.countries.includes("PT") && body.countries.includes("US"));
  assert.equal(new Set(body.countries).size, body.countries.length);
  assert.ok(body.countries.every(code => /^[A-Z]{2}$/.test(code)));
  assert.ok(body.countries.length >= 240, "lista completa da ISO, não um subconjunto");
});

test("get sem perfil devolve complete=false e profile=null", async () => {
  const cookie = await createAccount("novata");
  const [status, body] = await profile("get", {}, cookie);
  assert.equal(status, 200);
  assert.equal(body.complete, false);
  assert.equal(body.profile, null);
  assert.equal(typeof body.you, "string");
});

test("save valida nome, país e clube", async () => {
  const cookie = await createAccount("valida");
  const save = data => profile("save", data, cookie);
  assert.equal((await save({ name: "V", country: "BR", clubId: "seed-icrj" }))[0], 400, "nome curto");
  assert.equal((await save({ name: "x".repeat(31), country: "BR", clubId: "seed-icrj" }))[0], 400, "nome longo");
  assert.equal((await save({ name: "ab", country: "BR", clubId: "seed-icrj" }))[0], 400, "caractere de controle");
  assert.equal((await save({ name: "Velejadora", country: "XX", clubId: "seed-icrj" }))[0], 400, "país fora da ISO");
  assert.equal((await save({ name: "Velejadora", country: "br", clubId: "seed-icrj" }))[0], 200, "país em minúsculas é normalizado");
  assert.equal((await save({ name: "Velejadora", country: "BR", clubId: "nao-existe" }))[0], 404, "clube inexistente");
  assert.equal((await save({ name: "Velejadora", country: "BR" }))[0], 400, "clube ausente");
});

test("perfil completo não exige foto: nome, país e clube bastam (foto opcional, 28/11/2026)", async () => {
  const cookie = await createAccount("sem-foto");
  const [status, saved] = await profile("save", { name: "Vento Bom", country: "BR", clubId: "seed-icrj" }, cookie);
  assert.equal(status, 200);
  assert.equal(saved.complete, true, "sem foto o perfil já fica completo");
  assert.deepEqual(saved.avatar, { type: "emoji", emoji: "⛵" }, "sem escolha, o avatar padrão é ⛵");
  const [, got] = await profile("get", {}, cookie);
  assert.equal(got.complete, true);
  assert.equal(got.profile.photoAt, null);
  assert.equal(got.avatar.type, "emoji");
  assert.equal((await post("/api/rooms/create", { name: "A", settings }, { cookie }))[0], 200, "salas abrem sem foto");
  assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 200, "o site abre sem foto");
});

test("save valida o emoji do avatar contra a lista curada; escolha fica gravada", async () => {
  const cookie = await createAccount("emoji");
  const save = data => profile("save", data, cookie);
  assert.equal((await save({ name: "Emoji", country: "BR", clubId: "seed-icrj", emoji: "😀" }))[0], 400,
    "emoji fora da lista curada é recusado");
  assert.equal((await save({ name: "Emoji", country: "BR", clubId: "seed-icrj", emoji: 42 }))[0], 400,
    "emoji não textual é recusado");
  const [status, saved] = await save({ name: "Emoji", country: "BR", clubId: "seed-icrj", emoji: "🐋" });
  assert.equal(status, 200);
  assert.deepEqual(saved.avatar, { type: "emoji", emoji: "🐋" });
  const [, got] = await profile("get", {}, cookie);
  assert.equal(got.avatar.emoji, "🐋", "o emoji escolhido fica gravado");
  await save({ name: "Emoji", country: "PT", clubId: "seed-icrj" });
  assert.equal((await profile("get", {}, cookie))[1].avatar.emoji, "🐋",
    "salvar sem emoji não apaga a escolha");
});

test("remover a foto devolve o avatar ao emoji e mantém o perfil completo", async () => {
  const cookie = await createAccount("sem-foto-2");
  assert.equal((await profile("remove-photo", {}, cookie))[0], 409, "sem perfil salvo não há o que remover");
  await profile("save", { name: "Sem Foto", country: "BR", clubId: "seed-icrj", emoji: "🐬" }, cookie);
  const [idem, idemBody] = await profile("remove-photo", {}, cookie);
  assert.equal(idem, 200, "remover sem foto é idempotente");
  assert.equal(idemBody.avatar.emoji, "🐬");
  assert.equal((await upload(cookie, PNG)).status, 200);
  const [, comFoto] = await profile("get", {}, cookie);
  assert.equal(comFoto.avatar.type, "photo", "com foto, o avatar é a foto");
  const [rmStatus, removida] = await profile("remove-photo", {}, cookie);
  assert.equal(rmStatus, 200);
  assert.equal(removida.complete, true, "perfil segue completo sem a foto");
  assert.deepEqual(removida.avatar, { type: "emoji", emoji: "🐬" });
  assert.equal((await fetch(`${base}/api/profile/photo`, { headers: { cookie } })).status, 404,
    "a foto removida não é mais servida");
  const [, got] = await profile("get", {}, cookie);
  assert.equal(got.profile.photoAt, null);
  assert.equal(got.avatar.emoji, "🐬");
});

test("fluxo completo: save + foto completam o perfil; foto é servida com os cabeçalhos certos", async () => {
  const cookie = await createAccount("fluxo");
  const [saveStatus, saved] = await profile("save", { name: "  Maria   do Mar  ", country: "BR", clubId: "seed-veleiros-do-sul" }, cookie);
  assert.equal(saveStatus, 200);
  assert.equal(saved.profile.name, "Maria do Mar", "espaços são normalizados");
  assert.equal(saved.profile.club.id, "seed-veleiros-do-sul");
  assert.equal(saved.complete, true, "a foto é opcional: nome, país e clube bastam");
  assert.equal(saved.avatar.type, "emoji", "sem foto, o avatar é o emoji");

  assert.equal((await upload(cookie, PNG)).status, 200);
  const [, got] = await profile("get", {}, cookie);
  assert.equal(got.complete, true);
  assert.ok(got.profile.photoAt > 0);
  assert.equal(got.avatar.type, "photo", "com foto enviada, o avatar passa a ser a foto");
  assert.equal(got.avatar.photoAt, got.profile.photoAt);

  const foto = await fetch(`${base}/api/profile/photo`, { headers: { cookie } });
  assert.equal(foto.status, 200);
  assert.equal(foto.headers.get("content-type"), "image/png");
  assert.equal(foto.headers.get("x-content-type-options"), "nosniff");
  assert.match(foto.headers.get("cache-control"), /^private/);
  const etag = foto.headers.get("etag");
  assert.ok(etag);
  assert.deepEqual(Buffer.from(await foto.arrayBuffer()), PNG);
  assert.equal((await fetch(`${base}/api/profile/photo`, { headers: { cookie, "if-none-match": etag } })).status, 304);

  // Outra pessoa logada também vê a foto (vitrine do perfil); deslogada, não.
  const outra = await createAccount("colega");
  assert.equal((await fetch(`${base}/api/profile/photo/${got.you}`, { headers: { cookie: outra } })).status, 200);
  assert.equal((await fetch(`${base}/api/profile/photo/${got.you}`)).status, 401);
  assert.equal((await fetch(`${base}/api/profile/photo`, { headers: { cookie: outra } })).status, 404, "quem não enviou foto dá 404");
});

test("upload de foto valida formato pelos bytes, tamanho e ordem (perfil antes da foto)", async () => {
  const cookie = await createAccount("foto");
  assert.equal((await upload(cookie, PNG)).status, 409, "salve o perfil antes da foto");
  await profile("save", { name: "Fotógrafa", country: "PT", clubId: "seed-icrj" }, cookie);
  assert.equal((await upload(cookie, PNG, "text/html")).status, 415, "tipo declarado fora da lista");
  assert.equal((await upload(cookie, Buffer.from("<svg onload=alert(1)>"), "image/png")).status, 400, "bytes que não são imagem");
  assert.equal((await upload(cookie, JPEG, "image/png")).status, 400, "tipo declarado difere dos bytes");
  assert.equal((await upload(cookie, Buffer.alloc(2 * 1024 * 1024 + 1), "image/png")).status, 413, "acima de 2 MB");
  assert.equal((await upload(cookie, JPEG, "image/jpeg")).status, 200, "jpeg pelos bytes");
  assert.equal((await upload(cookie, WEBP, "image/webp")).status, 200, "webp pelos bytes");
  const foto = await fetch(`${base}/api/profile/photo`, { headers: { cookie } });
  assert.equal(foto.headers.get("content-type"), "image/webp", "a última foto vale");
});

test("upload remove metadados (EXIF/GPS, XMP, IPTC) antes de gravar; malformado dá 400", async () => {
  const cookie = await createAccount("metadados");
  await profile("save", { name: "Sem GPS", country: "BR", clubId: "seed-icrj" }, cookie);
  const servida = async () => Buffer.from(await (await fetch(`${base}/api/profile/photo`, { headers: { cookie } })).arrayBuffer());

  const comExif = jpeg();
  assert.ok(comExif.includes(Buffer.from(FAKE_GPS)), "a foto de teste traz GPS no EXIF");
  assert.equal((await upload(cookie, comExif, "image/jpeg")).status, 200);
  const jpegServido = await servida();
  assert.ok(!jpegServido.includes(Buffer.from(FAKE_GPS)), "o GPS não é servido");
  assert.ok(jpegServido.includes(Buffer.from("ICC_PROFILE")), "o perfil ICC continua");

  assert.equal((await upload(cookie, png(), "image/png")).status, 200);
  assert.ok(!(await servida()).includes(Buffer.from("Author")), "tEXt do PNG removido");

  assert.equal((await upload(cookie, webp(), "image/webp")).status, 200);
  const webpServido = await servida();
  assert.ok(!webpServido.includes(Buffer.from(FAKE_GPS)) && !webpServido.includes(Buffer.from("EXIF")),
    "EXIF do WebP removido");

  // Estrutura inválida (só os bytes iniciais conferem) é recusa 400, nunca 500.
  const truncado = jpeg().subarray(0, 9);
  assert.equal((await upload(cookie, truncado, "image/jpeg")).status, 400);
  assert.equal((await upload(cookie, PNG.subarray(0, 30), "image/png")).status, 400);
  assert.equal((await upload(cookie, Buffer.concat([WEBP, Buffer.from("lixo")]), "image/webp")).status, 400);
});

test("gate: perfil incompleto bloqueia salas (403) e redireciona os estáticos para /perfil.html", async () => {
  const cookie = await createAccount("gate");
  const [roomsStatus, roomsBody] = await post("/api/rooms/create", { name: "A", settings }, { cookie });
  assert.equal(roomsStatus, 403);
  assert.match(roomsBody.error, /perfil/i);
  const raiz = await fetch(`${base}/`, { redirect: "manual", headers: { cookie } });
  assert.equal(raiz.status, 302);
  assert.equal(raiz.headers.get("location"), "/perfil.html");
  assert.equal((await fetch(`${base}/game.js`, { redirect: "manual", headers: { cookie } })).status, 302);
  // A tela de perfil e o script dela abrem com a sessão incompleta; o POST que não é GET não vaza conteúdo.
  assert.equal((await fetch(`${base}/perfil.html`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/perfil.js`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/perfil.html`, { method: "POST", headers: { cookie } })).status, 404);
  // Depois de completar (sem foto — ela é opcional), tudo abre.
  assert.equal((await profile("save", { name: "Gate", country: "BR", clubId: "seed-icrj" }, cookie))[0], 200);
  assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 200);
  assert.equal((await post("/api/rooms/create", { name: "A", settings }, { cookie }))[0], 200);
});

test("clube pendente do próprio jogador completa o perfil; o de outra pessoa não aparece", async () => {
  const autor = await createAccount("autor");
  const [sugStatus, sug] = await profile("clubs/suggest", { name: "Clube de Vela da Represa", country: "BR", city: "Bauru" }, autor);
  assert.equal(sugStatus, 200);
  assert.equal(sug.existing, false);
  assert.equal(sug.club.status, "pending");
  await profile("save", { name: "Autor", country: "BR", clubId: sug.club.id }, autor);
  assert.equal((await upload(autor, PNG)).status, 200);
  assert.equal((await profile("get", {}, autor))[1].complete, true, "pendente do próprio autor vale");

  const outro = await createAccount("outro");
  const [, busca] = await profile("clubs/search", { query: "Represa" }, outro);
  assert.equal(busca.clubs.length, 0, "pendente de outra pessoa é invisível");
  const [, doAutor] = await profile("clubs/search", { query: "Represa" }, autor);
  assert.equal(doAutor.clubs[0].id, sug.club.id, "o autor encontra a própria sugestão");
  assert.equal((await profile("save", { name: "Outro", country: "BR", clubId: sug.club.id }, outro))[0], 404,
    "outra pessoa não vincula clube pendente alheio");
});

test("sugestão valida entrada, reaproveita clube aprovado e limita a 5 por hora", async () => {
  const cookie = await createAccount("sugestoes");
  const suggest = data => profile("clubs/suggest", data, cookie);
  assert.equal((await suggest({ name: "X", country: "BR" }))[0], 400, "nome curto");
  assert.equal((await suggest({ name: "Clube Novo", country: "ZZ" }))[0], 400, "país inválido");
  const [dupStatus, dup] = await suggest({ name: "veleiros do sul", country: "BR" });
  assert.equal(dupStatus, 200);
  assert.equal(dup.existing, true, "clube aprovado com o mesmo nome e país é reaproveitado");
  assert.equal(dup.club.id, "seed-veleiros-do-sul");
  for (let i = 1; i <= 5; i++) {
    assert.equal((await suggest({ name: `Clube da Série ${i}`, country: "AR" }))[0], 200);
  }
  const [estourou, corpo] = await suggest({ name: "Clube da Série 6", country: "AR" });
  assert.equal(estourou, 429);
  assert.match(corpo.error, /sugest/i);
});

test("busca de clubes: nome, filtro por país, paginação com limite e escape de curingas", async () => {
  const cookie = await createAccount("busca");
  const search = data => profile("clubs/search", data, cookie);
  const [, porNome] = await search({ query: "veleiros" });
  assert.ok(porNome.clubs.some(c => c.id === "seed-veleiros-do-sul"));
  assert.ok(porNome.clubs.every(c => c.status !== "pending" || c.mine));
  const [, porPais] = await search({ query: "clube", country: "BR" });
  assert.ok(porPais.clubs.every(c => c.country === "BR"));
  assert.equal((await search({ country: "BRZ" }))[0], 400);
  assert.equal((await search({ query: "x".repeat(61) }))[0], 400);
  assert.equal((await search({ limit: 0 }))[0], 400);
  assert.equal((await search({ limit: 51 }))[0], 400);
  assert.equal((await search({ offset: -1 }))[0], 400);
  assert.equal((await search({ query: "100%" }))[0], 200, "curinga escapado não quebra a busca");

  await pool.query(`INSERT INTO clubs(id,name,country,status,source,created)
    SELECT 'pag-'||i, 'Clube Paginado '||lpad(i::text,3,'0'), 'PT', 'approved', 'osm', $1 FROM generate_series(1,60) i`,
    [Date.now()]);
  const [, primeira] = await search({ query: "Clube Paginado" });
  assert.equal(primeira.clubs.length, 20, "padrão de 20 por página");
  assert.equal(primeira.hasMore, true);
  const [, ultima] = await search({ query: "Clube Paginado", limit: 50, offset: 50 });
  assert.equal(ultima.clubs.length, 10);
  assert.equal(ultima.hasMore, false);
  const [, teto] = await search({ query: "Clube Paginado", limit: 50 });
  assert.equal(teto.clubs.length, 50, "limite máximo 50");
});

test("login desligado: site abre sem sessão e a tela de perfil não atrapalha", async () => {
  const raiz = await fetch(`${openBase}/`);
  assert.equal(raiz.status, 200);
  const cookie = await createAccount("aberto");
  const r = await fetch(`${openBase}/api/profile/get`, { method: "POST",
    headers: { "content-type": "application/json", cookie }, body: "{}" });
  assert.equal(r.status, 200, "com sessão, a API de perfil responde também com o login desligado");
  assert.equal((await fetch(`${openBase}/`, { headers: { cookie } })).status, 200,
    "sem perfil completo o site continua aberto quando o login está desligado");
});

test("countries: a lista embutida é a oficial (amostras e formato)", () => {
  for (const code of ["BR", "PT", "AR", "US", "JP", "ZA", "IS", "TL"]) assert.ok(COUNTRY_CODES.has(code), code);
  for (const code of ["XX", "BR1", "", "USA"]) assert.ok(!COUNTRY_CODES.has(code), code);
  assert.ok(COUNTRY_CODES.size >= 240 && COUNTRY_CODES.size <= 260);
});
