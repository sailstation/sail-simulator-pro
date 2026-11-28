// Carreira do velejador (ADR-0008, issues #35/#36): catálogo versionado de classes e licenças,
// livro-razão de pontos só de acréscimo, provas (conquistas) e elegibilidade de salas ranqueadas.
// Os resultados vêm dos clientes (não autoritativos — #18/#10): todo lançamento e toda prova
// fica com verification='client' até existir servidor autoritativo; a troca muda a marca dos
// fatos novos, não o esquema. Ajuste manual de pontos e revogação de licença são por SQL
// documentado em docs/infra/servidor.md. Tudo exige sessão e perfil completo (gate no main.mjs).
import { randomUUID } from "node:crypto";

const ok = body => ({ status: 200, body });
const failure = (error, status, extra) => ({ status, body: { error, ...extra } });

// Catálogo de classes (definições da equipe, 27/11/2026 — #36): 420, Lightning e Star estão
// nos DOIS níveis — livres para treino, Quick Race e salas abertas; a categoria avançada delas
// exige licença. `roomClass` liga a classe da raia (settings.boatClass; o Laser corre como
// 'ilca') ao catálogo; null = a física ainda não existe no jogo. `license` é a exigência da
// categoria avançada (nomes a propor, ADR-0008). Licenciamento dos nomes e marcas: a verificar (#17).
export const CLASSES = Object.freeze([
  { id: "optimist", name: "Optimist", tiers: ["inicial"], roomClass: "optimist", license: null },
  { id: "laser", name: "Laser", tiers: ["inicial"], roomClass: "ilca", license: null },
  { id: "420", name: "420", tiers: ["inicial", "avancada"], roomClass: null, license: "clube" },
  { id: "snipe", name: "Snipe", tiers: ["inicial"], roomClass: "snipe", license: null },
  { id: "lightning", name: "Lightning", tiers: ["inicial", "avancada"], roomClass: null, license: "clube" },
  { id: "star", name: "Star", tiers: ["inicial", "avancada"], roomClass: "star", license: "clube" },
  { id: "hobiecat", name: "Hobie Cat", tiers: ["inicial"], roomClass: null, license: null },
  { id: "29er", name: "29er", tiers: ["avancada"], roomClass: null, license: "clube" },
  { id: "49er", name: "49er", tiers: ["avancada"], roomClass: null, license: "nacional" },
  { id: "j24", name: "J/24", tiers: ["avancada"], roomClass: null, license: "nacional" },
  { id: "nacra17", name: "Nacra 17", tiers: ["avancada"], roomClass: null, license: "internacional" },
  { id: "sailgp", name: "SailGP", tiers: ["avancada"], roomClass: null, license: "internacional" }
]);

// Escada de licenças (nomes e números a propor, ADR-0008): cada degrau exige o anterior, o
// saldo mínimo de pontos e as provas listadas. 'iniciante' é o ponto de partida de toda conta.
export const LICENSES = Object.freeze([
  { id: "iniciante", name: "Iniciante", minPoints: 0, achievements: [] },
  { id: "clube", name: "Clube", minPoints: 30, achievements: ["tutorial:optimist", "regatas:3"] },
  { id: "nacional", name: "Nacional", minPoints: 100, achievements: ["tutorial:laser", "regatas:10", "regata-limpa"] },
  { id: "internacional", name: "Internacional", minPoints: 250, achievements: ["tutorial:lightning", "regatas:25", "regata-limpa"] }
]);

// Marcos de regatas completas no modo Avançado que viram prova ('regatas:<n>'), computados pelo
// servidor a partir dos resultados gravados — nunca reportados pelo cliente.
export const RACE_MILESTONES = Object.freeze([1, 3, 5, 10, 25, 50]);

const MODES = ["iniciante", "avancado"];
const HISTORY_PAGE = 20;
const level = id => LICENSES.findIndex(license => license.id === id);

// Nome de exibição de uma prova, derivado do identificador.
export function achievementName(id) {
  if (id === "regata-limpa") return "Regata sem penalidade";
  const tutorial = /^tutorial:(.+)$/.exec(id);
  if (tutorial) {
    const cls = CLASSES.find(c => c.id === tutorial[1]);
    return cls ? `Tutorial: ${cls.name}` : id;
  }
  const regatas = /^regatas:(\d+)$/.exec(id);
  if (regatas) return `${regatas[1]} regatas completas no modo Avançado`;
  return id;
}

// Provas que o cliente pode reportar (ADR-0008): tutoriais de classe (#25) e regata sem
// penalidade — ambas marcadas verification='client'. Marcos de regatas não são reportáveis.
function reportable(id) {
  if (id === "regata-limpa") return true;
  const tutorial = /^tutorial:(.+)$/.exec(id);
  return Boolean(tutorial) && CLASSES.some(c => c.id === tutorial[1]);
}

// Tabela de pontos padrão (configurável na criação da API): o vencedor de uma flotilha com N
// barcos classificados leva N pontos, decrescendo de 1 até o último, que leva 1.
const defaultPointsFor = (position, fleet) => Math.max(1, fleet - position + 1);

export function createCareerApi(pool, { now = () => Date.now(), pointsFor = defaultPointsFor } = {}) {
  const one = async (text, params) => (await pool.query(text, params)).rows[0] ?? null;

  // Falha devolvida dentro da transação faz ROLLBACK (mesmo padrão das equipes, ADR-0007).
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      if (result && result.status >= 400) {
        await client.query("ROLLBACK");
        return result;
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // Os auxiliares aceitam `q` (pool ou cliente de transação) para rodar dentro ou fora de tx.
  const balanceOf = async (q, userId) =>
    (await q("SELECT COALESCE(sum(points), 0)::int AS n FROM point_entries WHERE user_id=$1", [userId])).rows[0].n;

  async function achievementsOf(q, userId) {
    const { rows } = await q("SELECT achievement, source, verification, created FROM achievements WHERE user_id=$1 ORDER BY created, achievement", [userId]);
    return rows;
  }

  async function highestLicense(q, userId) {
    const { rows } = await q("SELECT license FROM license_grants WHERE user_id=$1", [userId]);
    const granted = new Set(rows.map(row => row.license));
    for (let i = LICENSES.length - 1; i > 0; i--) if (granted.has(LICENSES[i].id)) return LICENSES[i].id;
    return LICENSES[0].id;
  }

  // Concessão automática (estilo ACC): percorre a escada e registra o primeiro degrau cujos
  // requisitos foram atingidos desde o último evento. Roda ao fim de todo fato que pode mudar
  // o estado (resultado de sala, prova reportada, consulta da carreira), então ajustes manuais
  // por SQL passam a valer no próximo evento. Idempotente; ON CONFLICT fecha a corrida.
  async function ensureLicenses(q, userId) {
    const balance = await balanceOf(q, userId);
    const have = new Set((await achievementsOf(q, userId)).map(row => row.achievement));
    const { rows } = await q("SELECT license FROM license_grants WHERE user_id=$1", [userId]);
    const granted = new Set(rows.map(row => row.license));
    let previous = true; // a licença anterior está garantida ('iniciante' sempre está)
    for (const license of LICENSES.slice(1)) {
      if (granted.has(license.id)) { previous = true; continue; }
      if (previous && balance >= license.minPoints && license.achievements.every(id => have.has(id))) {
        await q("INSERT INTO license_grants(user_id,license,created) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [userId, license.id, now()]);
        previous = true;
      } else previous = false;
    }
  }

  // O que falta para a licença: pontos e provas (a licença anterior aparece como prova própria
  // na escada devolvida pelo get; aqui interessa o degrau pedido).
  async function missingFor(userId, licenseId) {
    const license = LICENSES.find(item => item.id === licenseId);
    const balance = await balanceOf(pool.query.bind(pool), userId);
    const have = new Set((await achievementsOf(pool.query.bind(pool), userId)).map(row => row.achievement));
    return {
      points: Math.max(0, license.minPoints - balance),
      achievements: license.achievements.filter(id => !have.has(id)).map(id => ({ id, name: achievementName(id) }))
    };
  }

  // Elegibilidade (ADR-0008): a regra vale para a categoria avançada — classes puramente
  // avançadas exigem a licença em qualquer sala; classes das duas listas, só no modo Avançado.
  // Classe fora do catálogo (raias legadas como tp52) e salas abertas não exigem nada.
  async function checkEligible(user, boatClass, mode) {
    const cls = CLASSES.find(item => item.roomClass === boatClass || item.id === boatClass) ?? null;
    const gated = cls !== null && cls.license !== null &&
      (mode === "avancado" || !cls.tiers.includes("inicial"));
    if (!gated) return { allowed: true, license: user ? await highestLicense(pool.query.bind(pool), user.id) : LICENSES[0].id };
    const current = user ? await highestLicense(pool.query.bind(pool), user.id) : LICENSES[0].id;
    if (user && level(current) >= level(cls.license)) return { allowed: true, license: current };
    const required = LICENSES.find(item => item.id === cls.license);
    return {
      allowed: false, license: current, requires: required.id, requiresName: required.name,
      ...(user ? { missing: await missingFor(user.id, required.id) }
               : { reason: "session" })
    };
  }

  // Encerramento da regata pelo anfitrião (chamado por rooms.mjs): grava o resultado esportivo,
  // lança os pontos de quem pontua e computa os marcos de regatas. `entries` são as vagas
  // presentes no encerramento: { seat, userId, name, finish } (finish em segundos ou null).
  // A trava é o próprio UPDATE de rooms.finished: duas chamadas simultâneas não duplicam nada.
  async function recordRoomResult({ roomCode, settings, entries, at }) {
    return tx(async client => {
      const q = client.query.bind(client);
      const { rowCount } = await q("UPDATE rooms SET finished=$2 WHERE code=$1 AND finished IS NULL", [roomCode, at]);
      if (!rowCount) return failure("A regata desta sala já foi encerrada.", 409);
      const mode = settings.mode === "avancado" ? "avancado" : "iniciante";
      const finishers = entries.filter(entry => Number.isFinite(entry.finish))
        .sort((a, b) => a.finish - b.finish || a.seat - b.seat);
      const positionOf = new Map(finishers.map((entry, index) => [entry.seat, index + 1]));
      const fleet = finishers.length;
      // Pontos ranqueados (ADR-0008): só modo Avançado, com pelo menos 2 participantes, e a
      // verificação fica 'client' até o servidor autoritativo (#10/#18).
      const ranked = mode === "avancado" && entries.length >= 2;
      const resultId = randomUUID();
      await q("INSERT INTO room_results(id,room,boat_class,mode,humans,verification,created) VALUES($1,$2,$3,$4,$5,'client',$6)",
        [resultId, roomCode, settings.boatClass, mode, entries.length, at]);
      const results = [];
      for (const entry of entries) {
        const position = positionOf.get(entry.seat) ?? null;
        const points = ranked && position !== null && entry.userId ? pointsFor(position, fleet) : 0;
        await q("INSERT INTO room_result_entries(result_id,seat,user_id,name,position,finish,points) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [resultId, entry.seat, entry.userId, entry.name, position, position !== null ? entry.finish : null, points]);
        if (points > 0) {
          await q("INSERT INTO point_entries(user_id,points,source,source_ref,reason,verification,created) VALUES($1,$2,'room',$3,$4,'client',$5)",
            [entry.userId, points, resultId, `Regata ${settings.boatClass} (${fleet} ${fleet === 1 ? "barco" : "barcos"}): P${position}`, at]);
        }
        results.push({ seat: entry.seat, name: entry.name, position, finish: position !== null ? entry.finish : null, points });
      }
      // Marcos de regatas completas no Avançado: a contagem sai dos resultados gravados.
      if (mode === "avancado") {
        for (const entry of entries) {
          if (!entry.userId || !Number.isFinite(entry.finish)) continue;
          const { rows: [count] } = await q(
            `SELECT count(*)::int AS n FROM room_result_entries r
             JOIN room_results res ON res.id = r.result_id
             WHERE r.user_id=$1 AND r.finish IS NOT NULL AND res.mode='avancado'`, [entry.userId]);
          for (const milestone of RACE_MILESTONES.filter(m => m <= count.n)) {
            await q("INSERT INTO achievements(user_id,achievement,source,verification,created) VALUES($1,$2,'room','client',$3) ON CONFLICT DO NOTHING",
              [entry.userId, `regatas:${milestone}`, at]);
          }
        }
      }
      for (const entry of entries) if (entry.userId) await ensureLicenses(q, entry.userId);
      return ok({ ranked, results });
    });
  }

  // --- ações da API ------------------------------------------------------------------------------

  async function get(_data, user) {
    // A consulta reavalia a escada: ajustes manuais por SQL passam a valer aqui, sem SQL extra.
    await ensureLicenses(pool.query.bind(pool), user.id);
    const q = pool.query.bind(pool);
    const balance = await balanceOf(q, user.id);
    const current = await highestLicense(q, user.id);
    const { rows: grants } = await pool.query("SELECT license, created FROM license_grants WHERE user_id=$1", [user.id]);
    const grantedAt = new Map(grants.map(row => [row.license, row.created]));
    const achievementRows = await achievementsOf(q, user.id);
    const have = new Set(achievementRows.map(row => row.achievement));
    const { rows: history } = await pool.query(
      "SELECT points, source, source_ref, reason, verification, created FROM point_entries WHERE user_id=$1 ORDER BY id DESC LIMIT $2",
      [user.id, HISTORY_PAGE]);
    return ok({
      points: balance,
      license: { id: current, name: LICENSES.find(item => item.id === current).name },
      licenses: LICENSES.map(item => ({
        id: item.id, name: item.name, minPoints: item.minPoints,
        achievements: item.achievements.map(id => ({ id, name: achievementName(id), done: have.has(id) })),
        granted: item.id === "iniciante" || grantedAt.has(item.id),
        since: grantedAt.get(item.id) ?? null
      })),
      achievements: achievementRows.map(row => ({
        id: row.achievement, name: achievementName(row.achievement),
        source: row.source, verification: row.verification, created: row.created
      })),
      classes: CLASSES.map(cls => ({
        id: cls.id, name: cls.name, tiers: cls.tiers, roomClass: cls.roomClass,
        requires: cls.license, licensing: "a verificar",
        // Liberada = utilizável pela conta hoje: classe com nível inicial é sempre livre; a
        // exigência da categoria avançada aparece em `requires` e no gate das salas.
        unlocked: cls.license === null || cls.tiers.includes("inicial") || level(current) >= level(cls.license)
      })),
      history
    });
  }

  async function report(data, user) {
    const id = typeof data.achievement === "string" ? data.achievement : "";
    if (!reportable(id)) return failure("Conquista desconhecida ou não reportável pelo cliente.", 400);
    const at = now();
    const { rowCount } = await pool.query(
      "INSERT INTO achievements(user_id,achievement,source,verification,created) VALUES($1,$2,'client','client',$3) ON CONFLICT DO NOTHING",
      [user.id, id, at]);
    await ensureLicenses(pool.query.bind(pool), user.id);
    return ok({ ok: true, achievement: id, name: achievementName(id), already: rowCount === 0, verification: "client" });
  }

  // "Posso entrar nesta sala?" — o cliente consulta; o servidor aplica o mesmo gate em
  // create/join de salas (rooms.mjs). Sem `mode`, vale o padrão das salas: iniciante (aberta).
  async function eligible(data, user) {
    const boatClass = typeof data.boatClass === "string" ? data.boatClass : "";
    if (!boatClass) return failure("Informe a classe da sala.", 400);
    const mode = data.mode === undefined ? "iniciante" : data.mode;
    if (!MODES.includes(mode)) return failure("Modo inválido.", 400);
    return ok({ boatClass, mode, ...(await checkEligible(user, boatClass, mode)) });
  }

  const actions = { get, achievement: report, eligible };

  const handle = (action, data, user) =>
    (actions[action] ?? (() => failure("Ação indisponível.", 404)))(data, user);

  return { handle, checkEligible, recordRoomResult, ensureLicenses };
}
