// Teste ponta a ponta: login (cadastro + confirmação pela rota de teste + entrada) e API de salas.
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
