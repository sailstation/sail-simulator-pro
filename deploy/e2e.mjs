// Teste ponta a ponta da API de salas: node deploy/e2e.mjs https://sail-test.sailstation.com
// Cria uma sala, ocupa as 6 vagas, larga, sincroniza e sai. Use de preferência no ambiente de teste.
const base = process.argv[2];
const call = async (a, b) => { const r = await fetch(`${base}/api/rooms/${a}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return [r.status, await r.json()]; };
const settings = { venue: "central", boatClass: "star", sky: "mixed", weather: { wind: 11, gust: 14, dir: 145, wave: .48, waveDir: 155, period: 7, tide: .15, tideRate: .11, current: .2, currentDir: 65 } };
const ok = (c, m) => { if (!c) { console.log("FALHOU:", m); process.exitCode = 1; } else console.log("ok:", m); };
const [s1, h] = await call("create", { name: "Teste E2E", settings }); ok(s1 === 200, "criar sala " + h.code);
const guests = []; for (let i = 1; i <= 5; i++) { const [s, g] = await call("join", { code: h.code, name: "Conv " + i }); ok(s === 200, "entrar " + i); guests.push(g); }
ok((await call("join", { code: h.code, name: "Extra" }))[0] === 409, "sala cheia recusa 7º");
ok((await call("start", { code: h.code, token: guests[0].token }))[0] === 403, "convidado não larga");
const [s2, room] = await call("start", { code: h.code, token: h.token }); ok(s2 === 200 && room.starts - room.now === 480000 && typeof room.starts === "number", "anfitrião larga, relógio 8 min, número");
const boat = Object.fromEntries("x y h vx vy speed waterSpeed heel pitch heave rudderAngle downSide stage main jib mainAngle jibAngle crewPose extraHike".split(" ").map(k => [k, 0])); boat.x = 7; boat.y = -19;
ok((await call("sync", { code: h.code, token: guests[0].token, boat }))[0] === 200, "sync posição");
ok((await call("sync", { code: h.code, token: guests[0].token, boat: { ...boat, x: 999999 } }))[0] === 400, "posição inválida recusada");
const [, view] = await call("sync", { code: h.code, token: h.token }); const rec = view.players.find(p => p.id === guests[0].id);
ok(rec.boat.x === 7 && rec.boat.y === -19 && rec.token === undefined, "posição preservada e token oculto");
for (const g of guests) await call("leave", { code: h.code, token: g.token }); await call("leave", { code: h.code, token: h.token });
