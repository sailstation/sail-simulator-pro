// API de salas de regata sobre PostgreSQL nativo (ADR-0004).
// Lógica portada de worker/index.js com parâmetros $n; o contrato HTTP não muda.
const roomLife = 3 * 60 * 60_000;
const racePreparation = 8 * 60_000;
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), n => alphabet[n & 31]).join("");
const textName = value => typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
const limits = {
  wind: [0,60], gust: [0,90], dir: [0,360], wave: [0,12], waveDir: [0,360], period: [1,30],
  tide: [-5,5], tideRate: [-3,3], current: [0,4], currentDir: [0,360]
};
const boatLimits = {
  x: [-100000,100000], y: [-100000,100000], h: [-100000,100000], vx: [-25,25], vy: [-25,25],
  speed: [0,25], waterSpeed: [0,25], heel: [-4,4], pitch: [-2,2], heave: [-15,15],
  rudderAngle: [-2,2], downSide: [-1,1], stage: [0,40], main: [0,100], jib: [0,100],
  mainAngle: [-3.2,3.2], jibAngle: [-3.2,3.2], crewPose: [-3,3], extraHike: [0,1]
};

const ok = body => ({ status: 200, body });
const failure = (error, status) => ({ status, body: { error } });

function checkedNumbers(input, ranges) {
  if (!input || typeof input !== "object") return null;
  const numbers = {};
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = input[key];
    if (!Number.isFinite(value) || value < min || value > max) return null;
    numbers[key] = value;
  }
  return numbers;
}

function checkedSettings(input) {
  if (!input || !["central","north","canas","rio"].includes(input.venue) ||
      !["ilca","snipe","optimist","star","soto40","clubswan36","tp52","brasil40","columbia50","arpege30","cal40"].includes(input.boatClass) ||
      !["mixed","clear","cloudy","rain"].includes(input.sky)) return null;
  const weather = checkedNumbers(input.weather, limits);
  if (!weather) return null;
  if (input.venue === "canas") weather.dir = 90;
  weather.gust = Math.max(weather.wind, weather.gust);
  return { venue: input.venue, boatClass: input.boatClass, sky: input.sky === "rain" ? "cloudy" : input.sky, windShift: input.windShift === true, weather };
}

export function createRoomsApi(pool) {
  const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;

  async function view(room, now) {
    const { rows } = await pool.query("SELECT seat,id,name,seen,boat FROM sailors WHERE room=$1 ORDER BY seat", [room.code]);
    return {
      code: room.code, settings: JSON.parse(room.settings), starts: room.starts, now,
      players: rows.map(({seat,id,name,seen,boat}) => ({seat,id,name,online:now-seen<9000,boat:boat?JSON.parse(boat):null}))
    };
  }

  async function create(data, name, now) {
    const settings = checkedSettings(data.settings);
    if (!settings) return failure("Confira as condições da raia.", 400);
    const room = { code: roomCode(), settings: JSON.stringify(settings), starts: null };
    const id = crypto.randomUUID(), token = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM rooms WHERE expires < $1", [now]);
      await client.query("INSERT INTO rooms(code,settings,created,expires) VALUES ($1,$2,$3,$4)", [room.code, room.settings, now, now + roomLife]);
      await client.query("INSERT INTO sailors(room,seat,id,token,name,seen) VALUES ($1,0,$2,$3,$4,$5)", [room.code, id, token, name, now]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return ok({ ...(await view(room, now)), id, token });
  }

  async function join(data, name, code, now) {
    if (!/^[A-Z2-9]{7}$/.test(code)) return failure("Digite os 7 caracteres do código.", 400);
    const room = await one("SELECT * FROM rooms WHERE code=$1 AND expires>$2", [code, now]);
    if (!room) return failure("Sala não encontrada ou expirada.", 404);
    if (room.starts) return failure("A regata desta sala já começou.", 409);
    await pool.query(`DELETE FROM sailors WHERE room=$1 AND seat>0 AND seen<$2 AND
      EXISTS(SELECT 1 FROM rooms WHERE code=$3 AND starts IS NULL)`, [code, now - 90000, code]);
    const id = crypto.randomUUID(), token = crypto.randomUUID();
    const result = await pool.query(`INSERT INTO sailors(room,seat,id,token,name,seen)
      SELECT $1, free.seat, $2, $3, $4, $5 FROM (SELECT 1 AS seat UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) free
      WHERE EXISTS (SELECT 1 FROM rooms WHERE code=$6 AND starts IS NULL AND expires>$7)
        AND NOT EXISTS (SELECT 1 FROM sailors WHERE room=$8 AND seat=free.seat) ORDER BY free.seat LIMIT 1`,
      [code, id, token, name, now, code, now, code]);
    if (!result.rowCount) return failure("A sala está cheia ou a regata já começou.", 409);
    return ok({ ...(await view(room, now)), id, token });
  }

  async function handle(action, data) {
    const now = Date.now();
    const name = textName(data.name);
    const code = typeof data.code === "string" ? data.code.toUpperCase() : "";
    if (action === "create" || action === "join") {
      if (name.length < 1 || name.length > 24 || /[\p{Cc}\p{Cf}]/u.test(name)) return failure("Digite um nome de até 24 caracteres.", 400);
      if (action === "create") return create(data, name, now);
      return join(data, name, code, now);
    }

    if (!/^[A-Z2-9]{7}$/.test(code) || typeof data.token !== "string" || data.token.length !== 36) return failure("Sala indisponível.", 404);
    const member = await one(`SELECT rooms.*, sailors.seat FROM rooms
      JOIN sailors ON sailors.room=rooms.code WHERE rooms.code=$1 AND sailors.token=$2 AND rooms.expires>$3`, [code, data.token, now]);
    if (!member) return failure("A sala foi encerrada ou expirou.", 404);
    if (action === "leave") {
      if (member.seat === 0 && !member.starts) await pool.query("DELETE FROM rooms WHERE code=$1 AND starts IS NULL", [code]);
      else await pool.query("DELETE FROM sailors WHERE room=$1 AND token=$2", [code, data.token]);
      return ok({ ok: true });
    }
    if (action === "start" || action === "configure") {
      if (member.seat !== 0) return failure("Somente o anfitrião pode ajustar ou iniciar a regata.", 403);
      if (member.starts) return failure("A regata desta sala já começou.", 409);
      const settings = data.settings == null ? JSON.parse(member.settings) : checkedSettings(data.settings);
      if (!settings) return failure("Confira as condições da raia.", 400);
      const starts = action === "start" ? now + racePreparation : null;
      await pool.query("UPDATE rooms SET starts=$1,settings=$2 WHERE code=$3 AND starts IS NULL", [starts, JSON.stringify(settings), code]);
    } else if (action !== "sync") return failure("Ação indisponível.", 404);

    let boat = null;
    if (member.starts && data.boat != null) {
      boat = checkedNumbers(data.boat, boatLimits);
      if (!boat) return failure("Posição inválida.", 400);
      if (data.boat.soto) {
        boat.soto = checkedNumbers(data.boat.soto, { jib: [1,3], spi: [0,1] });
        if (boat.soto && Number.isFinite(data.boat.soto.sheet)) boat.soto.sheet = Math.max(0, Math.min(100, data.boat.soto.sheet));
        if (boat.soto && data.boat.soto.ease === 1) boat.soto.ease = 1;
        if (!boat.soto || !Number.isInteger(boat.soto.jib) || !Number.isInteger(boat.soto.spi)) return failure("Inventário inválido.", 400);
      }
      if (data.boat.starRig) {
        boat.starRig = checkedNumbers(data.boat.starRig, { outhaul: [0,1], cunningham: [0,1], runner: [0,1] });
        if (!boat.starRig) return failure("Ajuste do aparelho inválido.", 400);
      }
      if (data.boat.starMotion) {
        boat.starMotion = checkedNumbers(data.boat.starMotion, { stand: [0,1], fore: [-1,1], side: [-1,1] });
        if (!boat.starMotion) return failure("Movimento do proeiro inválido.", 400);
      }
      boat.stage = Math.trunc(boat.stage);
      boat.downSide = Math.sign(boat.downSide);
      boat.finish = Number.isFinite(data.boat.finish) && data.boat.finish >= 0 ? Math.min(10800, data.boat.finish) : null;
    }
    await pool.query("UPDATE sailors SET seen=$1,boat=COALESCE($2,boat) WHERE room=$3 AND token=$4", [now, boat ? JSON.stringify(boat) : null, code, data.token]);
    const current = await one("SELECT * FROM rooms WHERE code=$1", [code]);
    if (!current) return failure("A sala foi encerrada.", 404);
    return ok(await view(current, now));
  }

  return { handle };
}
