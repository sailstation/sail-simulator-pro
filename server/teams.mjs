// Equipes, convites e chat (ADR-0007, issue #34): escuderias persistentes como base das
// tripulações da #22. Um jogador participa de várias equipes (teto configurável) com uma
// principal; quem cria vira capitão e só o capitão convida, remove, transfere e apaga.
// Convites por nome de exibição (público, resolve na hora), por e-mail (gravado sem resolver
// a conta, para não revelar se o endereço tem cadastro) ou por link com token (só o hash é
// gravado, como nos e-mails do ADR-0005). O chat é texto puro com histórico paginado por
// cursor de id e polling (after); apagar mensagem é tombstone (o corpo sai do banco) e a
// denúncia guarda a cópia do texto para a moderação, que por ora é manual via SQL
// (docs/infra/servidor.md). Tudo exige sessão e perfil completo (gate no main.mjs).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { normalizeCountry } from "./countries.mjs";
import { normalizeEmail, EMAIL } from "./auth.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NAME_MIN = 3;
const NAME_MAX = 40;
const TAG = /^[A-Z0-9]{2,5}$/;
const REASON_MAX = 200;
const LINK_USES_MAX = 50;
const CONTROL = /[\u0000-\u001f\u007f]/u;

const ok = body => ({ status: 200, body });
const failure = (error, status) => ({ status, body: { error } });
const sha256 = value => createHash("sha256").update(value).digest("hex");

// Mesma limpeza de texto do perfil: apara e colapsa espaços.
const cleanText = value => typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
const hasControl = value => CONTROL.test(value);
const normName = value => value.toLowerCase();

const avatarOf = row => row.photo_at
  ? { type: "photo", photoAt: row.photo_at }
  : { type: "emoji", emoji: row.avatar_emoji };

const isId = value => typeof value === "string" && value.length > 0 && value.length <= 80;

export function createTeamsApi(pool, {
  now = () => Date.now(),
  maxMembers = Number(process.env.SAIL_TEAM_MAX_MEMBERS || 10),
  maxTeamsPerUser = 5,
  invitesPerHour = 20,
  messagesPerMinute = 10,
  messageMax = 500,
  reportsPerHour = 20,
  inviteTtlMs = 7 * 24 * HOUR,
  pageSize = 50,
  maxPage = 100
} = {}) {
  const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const membership = (userId, teamId) =>
    isId(teamId) ? one("SELECT * FROM team_members WHERE team_id=$1 AND user_id=$2", [teamId, userId]) : null;

  // Não-membro recebe 404, como se a equipe não existisse: nem a existência vaza.
  const NO_TEAM = () => failure("Equipe não encontrada.", 404);

  // Devolve a principal a quem ficou sem (a participação mais antiga assume).
  const ensurePrimary = (client, userId) => client.query(
    `UPDATE team_members SET is_primary=true
     WHERE user_id=$1 AND NOT EXISTS (SELECT 1 FROM team_members WHERE user_id=$1 AND is_primary)
       AND team_id=(SELECT team_id FROM team_members WHERE user_id=$1 ORDER BY joined, team_id LIMIT 1)`,
    [userId]);

  // --- consulta geral: minhas equipes, caixa de entrada e convites que enviei -----------------
  async function get(_data, user) {
    const at = now();
    const { rows: mine } = await pool.query(
      `SELECT t.id, t.name, t.tag, t.country, m.role, m.is_primary
       FROM team_members m JOIN teams t ON t.id = m.team_id
       WHERE m.user_id=$1 ORDER BY m.joined, t.id`, [user.id]);
    const teamIds = mine.map(team => team.id);
    const { rows: members } = teamIds.length ? await pool.query(
      `SELECT m.team_id, m.role, m.user_id, p.display_name, p.avatar_emoji, p.photo_at
       FROM team_members m JOIN profiles p ON p.user_id = m.user_id
       WHERE m.team_id = ANY($1) ORDER BY m.joined, m.user_id`, [teamIds]) : { rows: [] };
    const captained = mine.filter(team => team.role === "captain").map(team => team.id);
    const { rows: sent } = captained.length ? await pool.query(
      `SELECT i.id, i.team_id, i.invitee_email, i.token_hash, i.max_uses, i.uses, i.expires,
              p.display_name AS invitee_name
       FROM team_invites i LEFT JOIN profiles p ON p.user_id = i.invitee
       WHERE i.team_id = ANY($1) AND i.status='pending' AND i.expires > $2
       ORDER BY i.created`, [captained, at]) : { rows: [] };
    const { rows: inbox } = await pool.query(
      `SELECT i.id, i.expires, t.id AS team_id, t.name, t.tag, p.display_name AS from_name
       FROM team_invites i JOIN teams t ON t.id = i.team_id
       LEFT JOIN profiles p ON p.user_id = i.invited_by
       WHERE i.status='pending' AND i.expires > $2 AND i.token_hash IS NULL
         AND (i.invitee = $1 OR i.invitee_email = $3)
       ORDER BY i.created`, [user.id, at, user.email]);
    return ok({
      you: user.id,
      memberLimit: maxMembers,
      teams: mine.map(team => ({
        id: team.id, name: team.name, tag: team.tag, country: team.country,
        role: team.role, primary: team.is_primary,
        members: members.filter(m => m.team_id === team.id).map(m => ({
          id: m.user_id, name: m.display_name, avatar: avatarOf(m), role: m.role, you: m.user_id === user.id
        })),
        invites: sent.filter(i => i.team_id === team.id).map(i => ({
          id: i.id,
          kind: i.token_hash ? "link" : i.invitee_email ? "email" : "name",
          to: i.token_hash ? "link" : i.invitee_name ?? i.invitee_email,
          uses: i.uses, maxUses: i.max_uses, expires: i.expires
        }))
      })),
      invites: inbox.map(i => ({
        id: i.id, team: { id: i.team_id, name: i.name, tag: i.tag }, from: i.from_name, expires: i.expires
      }))
    });
  }

  // --- criar e administrar a equipe ------------------------------------------------------------
  async function create(data, user) {
    const name = cleanText(data.name);
    if (name.length < NAME_MIN || name.length > NAME_MAX || hasControl(name)) {
      return failure(`O nome da equipe precisa de ${NAME_MIN} a ${NAME_MAX} caracteres.`, 400);
    }
    const tag = typeof data.tag === "string" ? data.tag.trim().toUpperCase() : "";
    if (!TAG.test(tag)) return failure("A sigla precisa de 2 a 5 letras ou dígitos.", 400);
    let country = null;
    if (data.country !== undefined && data.country !== "") {
      country = normalizeCountry(data.country);
      if (!country) return failure("Escolha um país da lista, ou deixe em branco.", 400);
    }
    const at = now();
    try {
      return await tx(async client => {
        const { rows } = await client.query("SELECT count(*)::int AS n FROM team_members WHERE user_id=$1", [user.id]);
        if (rows[0].n >= maxTeamsPerUser) return failure(`Você já participa de ${maxTeamsPerUser} equipes.`, 409);
        const id = randomUUID();
        await client.query(
          "INSERT INTO teams(id,name,name_norm,tag,tag_norm,country,created_by,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [id, name, normName(name), tag, tag, country, user.id, at]);
        await client.query(
          "INSERT INTO team_members(team_id,user_id,role,is_primary,joined) VALUES($1,$2,'captain',$3,$4)",
          [id, user.id, rows[0].n === 0, at]);
        return ok({ ok: true, team: { id, name, tag, country, role: "captain", primary: rows[0].n === 0 } });
      });
    } catch (error) {
      // 23505: nome ou sigla duplicados (a checagem e o índice disputam a mesma corrida).
      if (error.code === "23505") return failure("Já existe uma equipe com esse nome ou essa sigla.", 409);
      throw error;
    }
  }

  async function leave(data, user) {
    const member = await membership(user.id, data.teamId);
    if (!member) return NO_TEAM();
    if (member.role === "captain") {
      const others = await one(
        "SELECT count(*)::int AS n FROM team_members WHERE team_id=$1 AND user_id<>$2", [data.teamId, user.id]);
      return failure(others.n > 0
        ? "Transfira a capitania para outro membro antes de sair."
        : "Você é o último membro: apague a equipe em vez de sair.", 409);
    }
    return tx(async client => {
      await client.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [data.teamId, user.id]);
      if (member.is_primary) await ensurePrimary(client, user.id);
      return ok({ ok: true });
    });
  }

  async function removeTeam(data, user) {
    const member = await membership(user.id, data.teamId);
    if (!member) return NO_TEAM();
    if (member.role !== "captain") return failure("Só o capitão apaga a equipe.", 403);
    return tx(async client => {
      const { rows: orphaned } = await client.query(
        "SELECT user_id FROM team_members WHERE team_id=$1 AND is_primary", [data.teamId]);
      await client.query("DELETE FROM teams WHERE id=$1", [data.teamId]);
      for (const { user_id: userId } of orphaned) await ensurePrimary(client, userId);
      return ok({ ok: true });
    });
  }

  async function transfer(data, user) {
    const member = await membership(user.id, data.teamId);
    if (!member) return NO_TEAM();
    if (member.role !== "captain") return failure("Só o capitão transfere a capitania.", 403);
    if (data.userId === user.id) return failure("Você já é o capitão.", 400);
    const target = await membership(data.userId, data.teamId);
    if (!target) return failure("Essa pessoa não faz parte da equipe.", 404);
    return tx(async client => {
      await client.query("UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2", [data.teamId, user.id]);
      await client.query("UPDATE team_members SET role='captain' WHERE team_id=$1 AND user_id=$2", [data.teamId, data.userId]);
      return ok({ ok: true });
    });
  }

  async function remove(data, user) {
    const member = await membership(user.id, data.teamId);
    if (!member) return NO_TEAM();
    if (member.role !== "captain") return failure("Só o capitão remove membros.", 403);
    if (data.userId === user.id) return failure("O capitão não se remove: transfira a capitania ou apague a equipe.", 400);
    const target = await membership(data.userId, data.teamId);
    if (!target || target.role === "captain") return failure("Membro não encontrado.", 404);
    return tx(async client => {
      await client.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [data.teamId, data.userId]);
      if (target.is_primary) await ensurePrimary(client, data.userId);
      return ok({ ok: true });
    });
  }

  async function setPrimary(data, user) {
    return tx(async client => {
      const member = await membership(user.id, data.teamId);
      if (!member) return NO_TEAM();
      await client.query("UPDATE team_members SET is_primary=false WHERE user_id=$1 AND is_primary", [user.id]);
      await client.query("UPDATE team_members SET is_primary=true WHERE team_id=$1 AND user_id=$2", [data.teamId, user.id]);
      return ok({ ok: true });
    });
  }

  // --- convites ----------------------------------------------------------------------------------
  async function inviteBudget(user, at) {
    const recent = await one(
      "SELECT count(*)::int AS n FROM team_invites WHERE invited_by=$1 AND created > $2", [user.id, at - HOUR]);
    return recent.n < invitesPerHour ? null
      : failure("Muitos convites em pouco tempo. Tente mais tarde.", 429);
  }

  async function invite(data, user) {
    const member = await membership(user.id, data.teamId);
    if (!member) return NO_TEAM();
    if (member.role !== "captain") return failure("Só o capitão convida.", 403);
    const hasName = data.name !== undefined && data.name !== "";
    const hasEmail = data.email !== undefined && data.email !== "";
    if (hasName === hasEmail) return failure("Informe o nome de exibição ou o e-mail de quem convidar.", 400);
    const at = now();
    const over = await inviteBudget(user, at);
    if (over) return over;
    let invitee = null;
    let inviteeEmail = null;
    if (hasName) {
      // Nome de exibição é público (aparece em equipes e no chat), então resolve na hora.
      const name = cleanText(data.name);
      const { rows } = await pool.query("SELECT user_id FROM profiles WHERE lower(display_name)=lower($1)", [name]);
      if (!rows.length) return failure("Ninguém com esse nome de exibição. Confira ou convide pelo e-mail.", 404);
      if (rows.length > 1) return failure("Há mais de um velejador com esse nome. Convide pelo e-mail.", 409);
      invitee = rows[0].user_id;
      if (invitee === user.id) return failure("Você já faz parte da equipe.", 400);
      if (await membership(invitee, data.teamId)) return failure("Essa pessoa já é da equipe.", 409);
      const dupe = await one(
        "SELECT 1 AS x FROM team_invites WHERE team_id=$1 AND invitee=$2 AND status='pending' AND expires>$3",
        [data.teamId, invitee, at]);
      if (dupe) return failure("Essa pessoa já tem um convite pendente.", 409);
    } else {
      // E-mail: gravado sem resolver a conta — a resposta é a mesma exista ou não, e o convite
      // aparece para o dono do endereço na consulta das próprias equipes (ADR-0007).
      inviteeEmail = normalizeEmail(data.email);
      if (!EMAIL.test(inviteeEmail)) return failure("Digite um e-mail válido.", 400);
      if (inviteeEmail === user.email) return failure("Você já faz parte da equipe.", 400);
      const dupe = await one(
        "SELECT 1 AS x FROM team_invites WHERE team_id=$1 AND invitee_email=$2 AND status='pending' AND expires>$3",
        [data.teamId, inviteeEmail, at]);
      if (dupe) return failure("Esse e-mail já tem um convite pendente.", 409);
    }
    await pool.query(
      `INSERT INTO team_invites(id,team_id,invited_by,invitee,invitee_email,created,expires)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), data.teamId, user.id, invitee, inviteeEmail, at, at + inviteTtlMs]);
    return ok({ ok: true, message: invitee
      ? "Convite enviado."
      : "Convite registrado. Se o e-mail tiver conta no jogo, o convite aparece para a pessoa." });
  }

  async function inviteLink(data, user) {
    const member = await membership(user.id, data.teamId);
    if (!member) return NO_TEAM();
    if (member.role !== "captain") return failure("Só o capitão convida.", 403);
    const uses = data.uses === undefined ? 1 : data.uses;
    if (!Number.isInteger(uses) || uses < 1 || uses > LINK_USES_MAX) {
      return failure(`O número de usos do link precisa ser de 1 a ${LINK_USES_MAX}.`, 400);
    }
    const at = now();
    const over = await inviteBudget(user, at);
    if (over) return over;
    const token = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO team_invites(id,team_id,invited_by,token_hash,max_uses,created,expires)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), data.teamId, user.id, sha256(token), uses, at, at + inviteTtlMs]);
    return ok({ ok: true, token, url: `/equipe.html#convite=${token}` });
  }

  async function revoke(data, user) {
    const member = await membership(user.id, data.teamId);
    if (!member) return NO_TEAM();
    if (member.role !== "captain") return failure("Só o capitão revoga convites.", 403);
    const { rowCount } = await pool.query(
      "UPDATE team_invites SET status='revoked' WHERE id=$1 AND team_id=$2 AND status='pending'",
      [typeof data.inviteId === "string" ? data.inviteId : "", data.teamId]);
    if (!rowCount) return failure("Convite não encontrado.", 404);
    return ok({ ok: true });
  }

  // Convite dirigido (por nome ou e-mail) pendente e endereçado a quem está na sessão.
  const inviteFor = (user, inviteId) => isId(inviteId) ? one(
    `SELECT * FROM team_invites WHERE id=$1 AND status='pending' AND expires>$2 AND token_hash IS NULL
       AND (invitee=$3 OR invitee_email=$4)`,
    [inviteId, now(), user.id, user.email]) : null;

  // Entrada na equipe com os tetos conferidos sob trava da linha da equipe (corrida de vagas).
  // `extra` roda dentro da transação e pode devolver uma falha para abortar a entrada.
  async function joinTeam(user, teamId, extra) {
    return tx(async client => {
      const team = await client.query("SELECT id FROM teams WHERE id=$1 FOR UPDATE", [teamId]);
      if (!team.rowCount) return NO_TEAM();
      const existing = await client.query("SELECT 1 AS x FROM team_members WHERE team_id=$1 AND user_id=$2", [teamId, user.id]);
      if (existing.rowCount) return failure("Você já faz parte desta equipe.", 409);
      const { rows: count } = await client.query("SELECT count(*)::int AS n FROM team_members WHERE team_id=$1", [teamId]);
      if (count[0].n >= maxMembers) return failure("A equipe está cheia.", 409);
      const { rows: mine } = await client.query("SELECT count(*)::int AS n FROM team_members WHERE user_id=$1", [user.id]);
      if (mine[0].n >= maxTeamsPerUser) return failure(`Você já participa de ${maxTeamsPerUser} equipes.`, 409);
      await client.query(
        "INSERT INTO team_members(team_id,user_id,role,is_primary,joined) VALUES($1,$2,'member',$3,$4)",
        [teamId, user.id, mine[0].n === 0, now()]);
      if (extra) {
        const result = await extra(client);
        if (result) return result;
      }
      return ok({ ok: true, teamId });
    });
  }

  async function accept(data, user) {
    const invite = await inviteFor(user, data.inviteId);
    if (!invite) return failure("Convite não encontrado ou expirado.", 404);
    return joinTeam(user, invite.team_id, async client => {
      const { rowCount } = await client.query(
        "UPDATE team_invites SET status='accepted', uses=uses+1 WHERE id=$1 AND status='pending'", [invite.id]);
      if (!rowCount) return failure("Convite não encontrado ou expirado.", 404);
    });
  }

  async function decline(data, user) {
    const invite = await inviteFor(user, data.inviteId);
    if (!invite) return failure("Convite não encontrado ou expirado.", 404);
    await pool.query("UPDATE team_invites SET status='declined' WHERE id=$1", [invite.id]);
    return ok({ ok: true });
  }

  async function joinLink(data, user) {
    const token = typeof data.token === "string" ? data.token : "";
    const invite = token ? await one(
      "SELECT * FROM team_invites WHERE token_hash=$1 AND status='pending' AND expires>$2",
      [sha256(token), now()]) : null;
    if (!invite) return failure("Link de convite inválido ou expirado.", 404);
    return joinTeam(user, invite.team_id, async client => {
      const { rowCount } = await client.query(
        `UPDATE team_invites SET uses=uses+1,
           status = CASE WHEN uses+1 >= max_uses THEN 'accepted' ELSE 'pending' END
         WHERE id=$1 AND status='pending' AND uses < max_uses`, [invite.id]);
      if (!rowCount) return failure("Link de convite inválido ou expirado.", 404);
    });
  }

  // --- chat --------------------------------------------------------------------------------------
  const messageView = viewer => row => ({
    id: row.id,
    created: row.created,
    deleted: row.deleted !== null,
    body: row.deleted !== null ? "" : row.body,
    user: row.user_id === null ? null : {
      id: row.user_id, name: row.display_name, avatar: avatarOf(row)
    },
    mine: row.user_id === viewer.id
  });

  const MESSAGE_SELECT = `
    SELECT m.id, m.body, m.created, m.deleted, m.user_id, p.display_name, p.avatar_emoji, p.photo_at
    FROM team_messages m LEFT JOIN profiles p ON p.user_id = m.user_id`;

  async function chat(data, user) {
    if (!await membership(user.id, data.teamId)) return NO_TEAM();
    const limit = data.limit === undefined ? pageSize : data.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maxPage) {
      return failure(`O limite precisa ser um número inteiro de 1 a ${maxPage}.`, 400);
    }
    const cursor = value => Number.isSafeInteger(value) && value >= 0;
    if (data.before !== undefined && data.after !== undefined) {
      return failure("Use before ou after, não os dois.", 400);
    }
    if (data.before !== undefined && !cursor(data.before)) return failure("Cursor inválido.", 400);
    if (data.after !== undefined && !cursor(data.after)) return failure("Cursor inválido.", 400);
    if (data.after !== undefined) {
      const { rows } = await pool.query(
        `${MESSAGE_SELECT} WHERE m.team_id=$1 AND m.id>$2 ORDER BY m.id ASC LIMIT $3`,
        [data.teamId, data.after, limit + 1]);
      const hasMore = rows.length > limit;
      return ok({ messages: rows.slice(0, limit).map(messageView(user)), hasMore });
    }
    const before = data.before === undefined ? Number.MAX_SAFE_INTEGER : data.before;
    const { rows } = await pool.query(
      `${MESSAGE_SELECT} WHERE m.team_id=$1 AND m.id<$2 ORDER BY m.id DESC LIMIT $3`,
      [data.teamId, before, limit + 1]);
    const hasMore = rows.length > limit;
    return ok({ messages: rows.slice(0, limit).reverse().map(messageView(user)), hasMore });
  }

  async function send(data, user) {
    if (!await membership(user.id, data.teamId)) return NO_TEAM();
    const body = typeof data.body === "string" ? data.body.trim() : "";
    if (!body || body.length > messageMax || hasControl(body)) {
      return failure(`A mensagem precisa de 1 a ${messageMax} caracteres, sem quebras de linha.`, 400);
    }
    const at = now();
    const recent = await one(
      "SELECT count(*)::int AS n FROM team_messages WHERE user_id=$1 AND created > $2", [user.id, at - MINUTE]);
    if (recent.n >= messagesPerMinute) return failure("Muitas mensagens em pouco tempo. Respire um pouco.", 429);
    const { rows } = await pool.query(
      "INSERT INTO team_messages(team_id,user_id,body,created) VALUES($1,$2,$3,$4) RETURNING id, created",
      [data.teamId, user.id, body, at]);
    const profile = await one("SELECT display_name, avatar_emoji, photo_at FROM profiles WHERE user_id=$1", [user.id]);
    return ok({ ok: true, message: messageView(user)({ ...rows[0], body, user_id: user.id, deleted: null, ...profile }) });
  }

  async function deleteMessage(data, user) {
    const member = await membership(user.id, data.teamId);
    if (!member) return NO_TEAM();
    const message = Number.isSafeInteger(data.messageId)
      ? await one("SELECT * FROM team_messages WHERE id=$1 AND team_id=$2", [data.messageId, data.teamId])
      : null;
    if (!message || message.deleted !== null) return failure("Mensagem não encontrada.", 404);
    if (message.user_id !== user.id && member.role !== "captain") {
      return failure("Só o autor ou o capitão apagam mensagens.", 403);
    }
    // Tombstone: o texto sai do banco; a linha fica para os clientes removerem no polling.
    await pool.query("UPDATE team_messages SET body='', deleted=$3 WHERE id=$1 AND team_id=$2",
      [data.messageId, data.teamId, now()]);
    return ok({ ok: true });
  }

  async function report(data, user) {
    if (!await membership(user.id, data.teamId)) return NO_TEAM();
    const reason = cleanText(data.reason);
    if (reason.length < 3 || reason.length > REASON_MAX || hasControl(reason)) {
      return failure(`O motivo da denúncia precisa de 3 a ${REASON_MAX} caracteres.`, 400);
    }
    const message = Number.isSafeInteger(data.messageId)
      ? await one("SELECT * FROM team_messages WHERE id=$1 AND team_id=$2 AND deleted IS NULL", [data.messageId, data.teamId])
      : null;
    if (!message) return failure("Mensagem não encontrada.", 404);
    const at = now();
    const recent = await one(
      "SELECT count(*)::int AS n FROM team_message_reports WHERE reporter=$1 AND created > $2", [user.id, at - HOUR]);
    if (recent.n >= reportsPerHour) return failure("Muitas denúncias em pouco tempo. Tente mais tarde.", 429);
    const dupe = await one(
      "SELECT 1 AS x FROM team_message_reports WHERE message_id=$1 AND reporter=$2", [data.messageId, user.id]);
    if (dupe) return failure("Você já denunciou esta mensagem.", 409);
    // A cópia do texto fica na denúncia mesmo que a mensagem vire tombstone depois.
    await pool.query(
      `INSERT INTO team_message_reports(id,message_id,team_id,reporter,reported_user,excerpt,reason,created)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), data.messageId, data.teamId, user.id, message.user_id, message.body, reason, at]);
    return ok({ ok: true, message: "Denúncia registrada. A moderação vai analisar." });
  }

  const actions = {
    get, create, leave, delete: removeTeam, transfer, remove, primary: setPrimary,
    invite, "invite-link": inviteLink, revoke, accept, decline, "join-link": joinLink,
    chat, send, "delete-message": deleteMessage, report
  };

  const handle = (action, data, user) =>
    (actions[action] ?? (() => failure("Ação indisponível.", 404)))(data, user);

  return { handle };
}
