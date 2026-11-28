// Perfil do velejador (ADR-0006): nome de exibição, país (ISO 3166-1 alfa-2), clube e foto.
// O perfil completo é exigido para jogar quando o login está obrigatório; a foto fica no
// PostgreSQL (bytea, até 2 MB) e só é servida para usuários com sessão. Clubes sugeridos por
// jogadores ficam "pending" e visíveis somente para o autor até a moderação (por SQL, por ora).
import { randomUUID } from "node:crypto";
import { normalizeCountry, COUNTRY_CODES } from "./countries.mjs";
import { stripImageMetadata, MalformedImageError } from "./image-metadata.mjs";

const PHOTO_MAX = 2 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const NAME_MIN = 2;
const NAME_MAX = 30;
const CLUB_NAME_MAX = 80;
const CITY_MAX = 80;
const SEARCH_QUERY_MAX = 60;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MAX_OFFSET = 100000;
const SUGGEST_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;

const ok = body => ({ status: 200, body });
const failure = (error, status) => ({ status, body: { error } });

// Mesma normalização de nome das salas: apara, colapsa espaços e recusa controles.
const cleanText = value => typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
const hasControl = value => /[\u0000-\u001f\u007f]/u.test(value);

// Bytes iniciais de cada formato aceito: o Content-Type declarado não é confiável (ADR-0006).
function sniffImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && PNG.every((byte, i) => bytes[i] === byte)) return "image/png";
  if (bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

const clubView = row => ({
  id: row.id, name: row.name, city: row.city, country: row.country,
  status: row.status, verified: row.verified, mine: row.mine === true
});

export function createProfileApi(pool, { now = () => Date.now() } = {}) {
  const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;

  // Completo = campos preenchidos + foto + clube utilizável (aprovado, ou pendente do próprio jogador).
  async function complete(userId) {
    const row = await one(
      `SELECT 1 AS ok FROM profiles p JOIN clubs c ON c.id = p.club_id
       WHERE p.user_id=$1 AND p.photo IS NOT NULL
         AND (c.status='approved' OR (c.status='pending' AND c.created_by=$1))`, [userId]);
    return Boolean(row);
  }

  async function get(_data, user) {
    const row = await one(
      `SELECT p.display_name, p.country, p.photo_at,
              c.id club_id, c.name club_name, c.city club_city, c.country club_country,
              c.status club_status, c.verified club_verified
       FROM profiles p JOIN clubs c ON c.id = p.club_id WHERE p.user_id=$1`, [user.id]);
    return ok({
      you: user.id,
      complete: await complete(user.id),
      profile: row === null ? null : {
        name: row.display_name,
        country: row.country,
        photoAt: row.photo_at,
        club: { id: row.club_id, name: row.club_name, city: row.club_city, country: row.club_country,
                status: row.club_status, verified: row.club_verified }
      }
    });
  }

  // O clube do perfil precisa existir e ser visível para o jogador: aprovado, ou pendente criado por ele.
  async function findClubFor(user, clubId) {
    if (typeof clubId !== "string" || clubId.length > 80) return null;
    const club = await one("SELECT * FROM clubs WHERE id=$1", [clubId]);
    if (!club || club.status === "rejected") return null;
    if (club.status === "pending" && club.created_by !== user.id) return null;
    return club;
  }

  async function save(data, user) {
    const name = cleanText(data.name);
    if (name.length < NAME_MIN || name.length > NAME_MAX || hasControl(name)) {
      return failure(`O nome de exibição precisa de ${NAME_MIN} a ${NAME_MAX} caracteres.`, 400);
    }
    const country = normalizeCountry(data.country);
    if (!country) return failure("Escolha um país da lista.", 400);
    if (typeof data.clubId !== "string" || !data.clubId) return failure("Escolha um clube da lista.", 400);
    const club = await findClubFor(user, data.clubId);
    if (!club) return failure("Clube não encontrado. Busque na lista ou sugira um novo.", 404);
    await pool.query(
      `INSERT INTO profiles(user_id,display_name,country,club_id,updated) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET display_name=$2, country=$3, club_id=$4, updated=$5`,
      [user.id, name, country, club.id, now()]);
    return ok({ ok: true, complete: await complete(user.id),
      profile: { name, country, club: clubView({ ...club, mine: true }) } });
  }

  // Upload binário (Content-Type image/jpeg|png|webp); os bytes precisam confirmar o formato.
  async function uploadPhoto(user, contentType, bytes) {
    if (!PHOTO_TYPES.has(contentType)) return failure("A foto precisa ser JPEG, PNG ou WebP.", 415);
    if (bytes.length > PHOTO_MAX) return failure("A foto pode ter no máximo 2 MB.", 413);
    const detected = bytes.length > 0 ? sniffImage(bytes) : null;
    if (detected === null || detected !== contentType) {
      return failure("O conteúdo não confere com o formato declarado. Envie um JPEG, PNG ou WebP válido.", 400);
    }
    // Metadados (EXIF/GPS, XMP, IPTC, comentários) saem antes de gravar: a foto pode ter
    // vindo direto do celular. Estrutura inválida é recusa 400, nunca exceção 500.
    let clean;
    try {
      clean = stripImageMetadata(bytes, contentType);
    } catch (error) {
      if (error instanceof MalformedImageError) {
        return failure("A imagem está corrompida. Exporte a foto de novo e tente outra vez.", 400);
      }
      throw error;
    }
    const { rowCount } = await pool.query(
      "UPDATE profiles SET photo=$2, photo_type=$3, photo_at=$4, updated=$4 WHERE user_id=$1",
      [user.id, clean, contentType, now()]);
    if (!rowCount) return failure("Salve o perfil antes de enviar a foto.", 409);
    return ok({ ok: true, photoAt: now(), complete: await complete(user.id) });
  }

  async function photoFor(userId) {
    if (typeof userId !== "string" || userId.length > 80) return null;
    return one("SELECT photo, photo_type, photo_at FROM profiles WHERE user_id=$1 AND photo IS NOT NULL", [userId]);
  }

  async function searchClubs(data, user) {
    const query = cleanText(data.query ?? "");
    if (query.length > SEARCH_QUERY_MAX) return failure("Busca muito longa.", 400);
    const country = data.country === undefined || data.country === "" ? null : normalizeCountry(data.country);
    if (data.country !== undefined && data.country !== "" && country === null) return failure("País inválido.", 400);
    const limit = data.limit === undefined ? SEARCH_DEFAULT_LIMIT : data.limit;
    const offset = data.offset === undefined ? 0 : data.offset;
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
      return failure(`O limite precisa ser um número inteiro de 1 a ${SEARCH_MAX_LIMIT}.`, 400);
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > SEARCH_MAX_OFFSET) {
      return failure("O deslocamento da página é inválido.", 400);
    }
    const like = query === "" ? null : "%" + query.replace(/[\\%_]/g, char => "\\" + char) + "%";
    const { rows } = await pool.query(
      `SELECT id, name, city, country, status, verified, created_by, created_by=$4 AS mine FROM clubs
       WHERE (status='approved' OR (status='pending' AND created_by=$4))
         AND ($1::text IS NULL OR name ILIKE $1 ESCAPE '\\')
         AND ($2::text IS NULL OR country=$2)
       ORDER BY name, id LIMIT $3 OFFSET $5`, [like, country, limit + 1, user.id, offset]);
    const hasMore = rows.length > limit;
    return ok({ clubs: rows.slice(0, limit).map(clubView), hasMore });
  }

  async function suggestClub(data, user) {
    const name = cleanText(data.name);
    if (name.length < 3 || name.length > CLUB_NAME_MAX || hasControl(name)) {
      return failure(`O nome do clube precisa de 3 a ${CLUB_NAME_MAX} caracteres.`, 400);
    }
    const country = normalizeCountry(data.country);
    if (!country) return failure("Escolha o país do clube na lista.", 400);
    const city = cleanText(data.city ?? "");
    if (city.length > CITY_MAX || hasControl(city)) return failure("Cidade inválida.", 400);
    const existing = await one(
      "SELECT * FROM clubs WHERE lower(name)=lower($1) AND country=$2 AND status='approved'", [name, country]);
    if (existing) return ok({ existing: true, club: clubView({ ...existing, mine: true }) });
    const at = now();
    const recent = await one(
      "SELECT count(*)::int AS total FROM clubs WHERE created_by=$1 AND created > $2", [user.id, at - HOUR_MS]);
    if (recent.total >= SUGGEST_PER_HOUR) {
      return failure("Muitas sugestões de clube em pouco tempo. Tente mais tarde.", 429);
    }
    const club = { id: randomUUID(), name, country, city: city || null,
      status: "pending", source: "player", verified: false };
    await pool.query(
      "INSERT INTO clubs(id,name,country,city,status,source,verified,created_by,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [club.id, club.name, club.country, club.city, club.status, club.source, club.verified, user.id, at]);
    return ok({ existing: false, club: clubView({ ...club, mine: true }) });
  }

  const actions = {
    get, save,
    countries: async () => ok({ countries: [...COUNTRY_CODES].sort() }),
    "clubs/search": searchClubs,
    "clubs/suggest": suggestClub
  };

  const handle = (action, data, user) =>
    (actions[action] ?? (() => failure("Ação indisponível.", 404)))(data, user);

  return { handle, complete, uploadPhoto, photoFor };
}
