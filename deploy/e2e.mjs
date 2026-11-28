// Teste ponta a ponta: login (cadastro + confirmação pela rota de teste + entrada), perfil
// obrigatório (ADR-0006: nome, país e clube; a foto é opcional e o avatar sem foto é um emoji
// da lista curada) e API de salas.
// O servidor precisa estar com SAIL_ENV=test (ambiente de teste), que habilita /api/auth/test-confirm.
// Uso: node deploy/e2e.mjs https://sail-test.sailstation.com
import { createHash } from "node:crypto";

const base = process.argv[2];
if (!base) { console.error("uso: node deploy/e2e.mjs <endereço>"); process.exit(1); }

let cookie = "";
const call = async (scope, action, body) => {
  const r = await fetch(`${base}/api/${scope}/${action}`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body)
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return [r.status, await r.json().catch(() => ({}))];
};
const ok = (c, m) => { if (!c) { console.log("FALHOU:", m); process.exitCode = 1; } else console.log("ok:", m); };

// Prova de trabalho, como o navegador faz na tela de entrada.
const solve = ({ challenge, signature }) => {
  const bits = Number(challenge.split(".")[2]);
  for (let nonce = 0; ; nonce++) {
    const digest = createHash("sha256").update(`${challenge}.${nonce}`).digest();
    let zeros = 0;
    for (const byte of digest) { if (byte === 0) { zeros += 8; continue; } zeros += Math.clz32(byte) - 24; break; }
    if (zeros >= bits) return { challenge, signature, nonce };
  }
};

// Sem sessão, nada abre.
ok((await fetch(`${base}/`, { redirect: "manual" })).status === 302, "site sem sessão redireciona para a entrada");
ok((await call("rooms", "create", { name: "x", settings: {} }))[0] === 401, "API de salas exige sessão");
ok((await fetch(`${base}/login.html`)).status === 200, "tela de entrada abre sem sessão");

// Cadastro, confirmação (rota de teste) e login.
const email = `e2e-${Date.now()}@teste.invalid`;
const password = `e2e-${crypto.randomUUID()}`;
const [, challenge] = await call("auth", "challenge", {});
ok((await call("auth", "signup", { email, password, pow: solve(challenge) }))[0] === 200, "cadastro com prova de trabalho");
ok((await call("auth", "test-confirm", { email }))[0] === 200, "confirmação de e-mail (rota de teste)");
ok((await call("auth", "login", { email, password }))[0] === 200 && cookie, "login devolve cookie de sessão");

// Perfil obrigatório (ADR-0006): incompleto bloqueia o jogo até nome, país e clube estarem
// preenchidos. A foto é opcional: sem ela o avatar é o emoji escolhido (padrão ⛵).
const settings0 = { venue: "central", boatClass: "star", sky: "mixed", weather: { wind: 11, gust: 14, dir: 145, wave: .48, waveDir: 155, period: 7, tide: .15, tideRate: .11, current: .2, currentDir: 65 } };
ok((await call("rooms", "create", { name: "x", settings: settings0 }))[0] === 403, "salas bloqueadas com perfil incompleto");
ok((await fetch(`${base}/`, { redirect: "manual", headers: { cookie } })).status === 302, "site redireciona para a tela de perfil");
ok((await fetch(`${base}/perfil.html`, { headers: { cookie } })).status === 200, "tela de perfil abre com a sessão");
const [, perfil] = await call("profile", "get", {}); ok(perfil.complete === false, "perfil nasce incompleto");
const [, paises] = await call("profile", "countries", {}); ok(paises.countries.includes("BR"), "lista de países com BR");
const [, avatares] = await call("profile", "avatars", {}); ok(avatares.emojis.includes("⛵") && avatares.emojis.includes("🐬"), "lista curada de emojis de avatar");
const [, busca] = await call("profile", "clubs/search", { query: "veleiros" });
ok(busca.clubs.some(c => c.id === "seed-veleiros-do-sul"), "busca encontra clube da semente");
const [sSug, sug] = await call("profile", "clubs/suggest", { name: `Clube E2E ${Date.now()}`, country: "BR", city: "Santos" });
ok(sSug === 200 && sug.club.status === "pending", "sugestão de clube fica pendente");
ok((await call("profile", "save", { name: "Piloto E2E", country: "BR", clubId: sug.club.id }))[0] === 200, "perfil salvo");
const [, semFoto] = await call("profile", "get", {});
ok(semFoto.complete === true && semFoto.avatar.type === "emoji" && semFoto.avatar.emoji === "⛵",
  "sem foto o perfil fica completo com o avatar padrão ⛵");
ok((await call("profile", "save", { name: "Piloto E2E", country: "BR", clubId: sug.club.id, emoji: "🐬" }))[0] === 200, "escolha do emoji de avatar");
ok((await call("profile", "save", { name: "Piloto E2E", country: "BR", clubId: sug.club.id, emoji: "😀" }))[0] === 400, "emoji fora da lista é recusado");
const [, comEmoji] = await call("profile", "get", {});
ok(comEmoji.avatar.type === "emoji" && comEmoji.avatar.emoji === "🐬", "perfil sem foto com o emoji escolhido");
ok((await fetch(`${base}/`, { redirect: "manual", headers: { cookie } })).status === 200, "site abre sem foto, com o emoji");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const envio = await fetch(`${base}/api/profile/photo`, { method: "POST", headers: { "content-type": "image/png", cookie }, body: png });
ok(envio.status === 200, "upload da foto");
const foto = await fetch(`${base}/api/profile/photo`, { headers: { cookie } });
ok(foto.status === 200 && foto.headers.get("content-type") === "image/png", "foto servida com o tipo certo");
const [, comFoto] = await call("profile", "get", {});
ok(comFoto.avatar.type === "photo", "com foto enviada, o avatar é a foto");
const [sRem, removida] = await call("profile", "remove-photo", {});
ok(sRem === 200 && removida.complete === true && removida.avatar.emoji === "🐬",
  "remover a foto volta ao emoji e o perfil segue completo");
ok((await fetch(`${base}/api/profile/photo`, { headers: { cookie } })).status === 404, "foto removida não é mais servida");
ok((await fetch(`${base}/`, { redirect: "manual", headers: { cookie } })).status === 200, "site abre com o perfil completo");

// Salas, como antes.
const settings = { venue: "central", boatClass: "star", sky: "mixed", weather: { wind: 11, gust: 14, dir: 145, wave: .48, waveDir: 155, period: 7, tide: .15, tideRate: .11, current: .2, currentDir: 65 } };
const [s1, h] = await call("rooms", "create", { name: "Teste E2E", settings }); ok(s1 === 200, "criar sala " + h.code);
const guests = []; for (let i = 1; i <= 5; i++) { const [s, g] = await call("rooms", "join", { code: h.code, name: "Conv " + i }); ok(s === 200, "entrar " + i); guests.push(g); }
ok((await call("rooms", "join", { code: h.code, name: "Extra" }))[0] === 409, "sala cheia recusa 7º");
ok((await call("rooms", "start", { code: h.code, token: guests[0].token }))[0] === 403, "convidado não larga");
const [s2, room] = await call("rooms", "start", { code: h.code, token: h.token }); ok(s2 === 200 && room.starts - room.now === 480000 && typeof room.starts === "number", "anfitrião larga, relógio 8 min, número");
const boat = Object.fromEntries("x y h vx vy speed waterSpeed heel pitch heave rudderAngle downSide stage main jib mainAngle jibAngle crewPose extraHike".split(" ").map(k => [k, 0])); boat.x = 7; boat.y = -19;
ok((await call("rooms", "sync", { code: h.code, token: guests[0].token, boat }))[0] === 200, "sync posição");
ok((await call("rooms", "sync", { code: h.code, token: guests[0].token, boat: { ...boat, x: 999999 } }))[0] === 400, "posição inválida recusada");
const [, view] = await call("rooms", "sync", { code: h.code, token: h.token }); const rec = view.players.find(p => p.id === guests[0].id);
ok(rec.boat.x === 7 && rec.boat.y === -19 && rec.token === undefined, "posição preservada e token oculto");
for (const g of guests) await call("rooms", "leave", { code: h.code, token: g.token }); await call("rooms", "leave", { code: h.code, token: h.token });

// Sair encerra o acesso.
ok((await call("auth", "logout", {}))[0] === 200, "sair");
ok((await call("rooms", "create", { name: "x", settings }))[0] === 401, "sem sessão depois de sair");
