// Contas, sessões e e-mails de confirmação/recuperação (login obrigatório, ADR-0005).
// Senha com scrypt do Node (sem dependência nativa), tokens guardados só como hash,
// limite de tentativas por IP e por e-mail com bloqueio progressivo, e mensagens
// que não revelam se um e-mail tem conta.
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const CONFIRM_TTL_MS = 24 * 60 * 60_000;
const RECOVER_TTL_MS = 60 * 60_000;
const COOKIE = "sail_session";
const MINUTE = 60_000;

// Limites: `max` ocorrências na janela disparam bloqueio de `blockMs`, dobrando a cada
// nova ocorrência até `maxBlockMs`. Login conta falhas; cadastro e recuperação contam pedidos.
export const LIMITS = {
  loginEmail: { max: 5, windowMs: 15 * MINUTE, blockMs: MINUTE, maxBlockMs: 15 * MINUTE },
  loginIp: { max: 20, windowMs: 15 * MINUTE, blockMs: MINUTE, maxBlockMs: 15 * MINUTE },
  signupIp: { max: 10, windowMs: 60 * MINUTE, blockMs: 60 * MINUTE, maxBlockMs: 60 * MINUTE },
  recoverIp: { max: 10, windowMs: 60 * MINUTE, blockMs: 60 * MINUTE, maxBlockMs: 60 * MINUTE }
};

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/; // validação simples, sem RFC completa
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

const ok = (body, cookie) => ({ status: 200, body, cookie });
const failure = (error, status) => ({ status, body: { error } });
const sha256 = value => createHash("sha256").update(value).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
export const normalizeEmail = value => (typeof value === "string" ? value.trim().toLowerCase() : "");

export function createAuthApi(pool, {
  mail, pow, baseUrl = "",
  scryptParams = { N: 131072, r: 8, p: 1 },  // OWASP: scrypt N=2^17, r=8, p=1
  limits = LIMITS,
  testMode = false,
  secureCookies = true,
  now = () => Date.now()
} = {}) {
  const hashPassword = async password => {
    const { N, r, p } = scryptParams;
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, 32, { N, r, p, maxmem: 256 * N * r });
    return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
  };
  const verifyPassword = async (password, stored) => {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    if (!(N >= 2 && N <= 2 ** 20) || !(r >= 1 && r <= 16) || !(p >= 1 && p <= 4)) return false;
    const expected = Buffer.from(parts[5], "base64");
    const salt = Buffer.from(parts[4], "base64");
    const key = await scrypt(String(password), salt, expected.length, { N, r, p, maxmem: 256 * N * r });
    return timingSafeEqual(expected, key);
  };
  // Hash descartável para o login com e-mail inexistente gastar o mesmo tempo (sem oráculo de timing).
  let dummy;
  const dummyHash = () => (dummy ??= hashPassword(newToken()));

  // --- limite de tentativas -----------------------------------------------------------------
  const secondsUntil = (blockedUntil, at) => Math.max(0, Math.ceil((blockedUntil - at) / 1000));
  async function blocked(scope, key, at) {
    const { rows } = await pool.query("SELECT blocked_until FROM auth_attempts WHERE scope=$1 AND key=$2", [scope, key]);
    return rows[0]?.blocked_until > at ? secondsUntil(rows[0].blocked_until, at) : 0;
  }
  async function record(scope, key, cfg, at) {
    await pool.query(`INSERT INTO auth_attempts(scope,key,count,first) VALUES($1,$2,1,$3)
      ON CONFLICT (scope,key) DO UPDATE SET
        count = CASE WHEN auth_attempts.first < $4 THEN 1 ELSE auth_attempts.count + 1 END,
        first = CASE WHEN auth_attempts.first < $4 THEN $3 ELSE auth_attempts.first END`,
      [scope, key, at, at - cfg.windowMs]);
    const { rows } = await pool.query("SELECT count FROM auth_attempts WHERE scope=$1 AND key=$2", [scope, key]);
    const count = rows[0].count;
    if (count >= cfg.max) {
      const penalty = Math.min(cfg.blockMs * 2 ** (count - cfg.max), cfg.maxBlockMs);
      await pool.query("UPDATE auth_attempts SET blocked_until=$3 WHERE scope=$1 AND key=$2", [scope, key, at + penalty]);
    }
  }
  const clear = (scope, key) => pool.query("DELETE FROM auth_attempts WHERE scope=$1 AND key=$2", [scope, key]);

  // --- sessões --------------------------------------------------------------------------------
  async function openSession(userId, at) {
    const token = newToken();
    await pool.query("DELETE FROM sessions WHERE expires <= $1", [at]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,created,expires) VALUES($1,$2,$3,$4)",
      [sha256(token), userId, at, at + SESSION_TTL_MS]);
    return token;
  }
  const tokenFrom = req => new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(req.headers?.cookie ?? "")?.[1] ?? null;
  async function session(token) {
    if (!token) return null;
    const { rows } = await pool.query(
      `SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE token_hash=$1 AND expires>$2 AND users.confirmed IS NOT NULL`, [sha256(token), now()]);
    return rows[0] ?? null;
  }
  const flags = `Path=/; HttpOnly; ${secureCookies ? "Secure; " : ""}SameSite=Lax`;
  const cookieFor = token => `${COOKIE}=${token}; ${flags}; Max-Age=${SESSION_TTL_MS / 1000}`;
  const clearCookie = `${COOKIE}=; ${flags}; Max-Age=0`;

  // --- e-mails com token ----------------------------------------------------------------------
  const link = (fragment, token) => `${baseUrl}/login.html#${fragment}=${token}`;
  async function sendTokenMail(user, kind, ttlMs, subject, body) {
    const token = newToken();
    await pool.query("DELETE FROM email_tokens WHERE user_id=$1 AND kind=$2", [user.id, kind]);
    await pool.query("INSERT INTO email_tokens(token_hash,user_id,kind,expires) VALUES($1,$2,$3,$4)",
      [sha256(token), user.id, kind, now() + ttlMs]);
    await mail.send({ to: user.email, subject, text: body(token) });
  }
  const sendConfirm = user => sendTokenMail(user, "confirm", CONFIRM_TTL_MS,
    "Confirme seu e-mail — Sail Simulator Pro",
    token => `Confirme seu e-mail para ativar sua conta no Sail Simulator Pro:\n\n${link("confirmar", token)}\n\nO link vale por 24 horas. Se não foi você, ignore esta mensagem.`);
  const sendRecover = user => sendTokenMail(user, "recover", RECOVER_TTL_MS,
    "Redefinir sua senha — Sail Simulator Pro",
    token => `Para redefinir sua senha, abra:\n\n${link("redefinir", token)}\n\nO link vale por 1 hora e só pode ser usado uma vez. Se não foi você, ignore esta mensagem.`);

  // --- ações ----------------------------------------------------------------------------------
  async function signup(data, ctx) {
    if (!pow.verify(data.pow)) return failure("Verificação anti-robô inválida ou expirada. Tente de novo.", 403);
    const at = now();
    if (await blocked("signup", ctx.ip, at)) return failure("Muitos cadastros deste endereço. Tente mais tarde.", 429);
    await record("signup", ctx.ip, limits.signupIp, at);
    const email = normalizeEmail(data.email);
    if (!EMAIL.test(email)) return failure("Digite um e-mail válido.", 400);
    if (typeof data.password !== "string" || data.password.length < PASSWORD_MIN || data.password.length > PASSWORD_MAX) {
      return failure(`A senha precisa de ${PASSWORD_MIN} a ${PASSWORD_MAX} caracteres.`, 400);
    }
    const pass = await hashPassword(data.password); // sempre, para não vazar pela demora se o e-mail existe
    const existing = (await pool.query("SELECT * FROM users WHERE email=$1", [email])).rows[0];
    if (existing) {
      if (existing.confirmed) {
        await mail.send({ to: email, subject: "Sua conta no Sail Simulator Pro",
          text: "Alguém tentou criar uma conta com este e-mail, mas ele já está cadastrado. Se foi você, use Entrar ou a recuperação de senha." });
      } else {
        await sendConfirm(existing);
      }
    } else {
      const id = randomUUID();
      await pool.query("INSERT INTO users(id,email,pass,created) VALUES($1,$2,$3,$4)", [id, email, pass, at]);
      await sendConfirm({ id, email });
    }
    return ok({ ok: true, message: "Se os dados estiverem certos, você receberá um e-mail para confirmar a conta." });
  }

  async function confirm(data) {
    const token = typeof data.token === "string" ? data.token : "";
    const { rows } = await pool.query(
      "DELETE FROM email_tokens WHERE token_hash=$1 AND kind='confirm' AND expires>$2 RETURNING user_id", [sha256(token), now()]);
    if (!rows[0]) return failure("Link inválido ou expirado. Peça um novo e-mail de confirmação.", 400);
    await pool.query("UPDATE users SET confirmed=$1 WHERE id=$2", [now(), rows[0].user_id]);
    return ok({ ok: true, message: "E-mail confirmado. Você já pode entrar." });
  }

  async function login(data, ctx) {
    const at = now();
    const email = normalizeEmail(data.email);
    const password = typeof data.password === "string" ? data.password : "";
    if (Math.max(await blocked("email", email, at), await blocked("ip", ctx.ip, at)) > 0) {
      return failure("Muitas tentativas. Aguarde um pouco e tente de novo.", 429);
    }
    const user = (await pool.query("SELECT * FROM users WHERE email=$1", [email])).rows[0];
    const valid = await verifyPassword(password, user?.pass ?? await dummyHash());
    if (!user || !valid) {
      await record("email", email, limits.loginEmail, at);
      await record("ip", ctx.ip, limits.loginIp, at);
      return failure("E-mail ou senha incorretos.", 401);
    }
    if (!user.confirmed) return failure("Confirme seu e-mail antes de entrar.", 403);
    await clear("email", email);
    await clear("ip", ctx.ip);
    return ok({ ok: true, email: user.email }, cookieFor(await openSession(user.id, at)));
  }

  async function logout(ctx) {
    if (ctx.token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [sha256(ctx.token)]);
    return ok({ ok: true }, clearCookie);
  }

  async function logoutAll(ctx) {
    const user = await session(ctx.token);
    if (!user) return failure("Sessão expirada. Entre de novo.", 401);
    await pool.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
    return ok({ ok: true }, clearCookie);
  }

  async function recover(data, ctx) {
    if (!pow.verify(data.pow)) return failure("Verificação anti-robô inválida ou expirada. Tente de novo.", 403);
    const at = now();
    if (await blocked("recover", ctx.ip, at)) return failure("Muitos pedidos deste endereço. Tente mais tarde.", 429);
    await record("recover", ctx.ip, limits.recoverIp, at);
    const user = (await pool.query("SELECT * FROM users WHERE email=$1 AND confirmed IS NOT NULL", [normalizeEmail(data.email)])).rows[0];
    if (user) await sendRecover(user);
    return ok({ ok: true, message: "Se houver uma conta com esse e-mail, enviaremos o link para redefinir a senha." });
  }

  async function reset(data) {
    if (typeof data.password !== "string" || data.password.length < PASSWORD_MIN || data.password.length > PASSWORD_MAX) {
      return failure(`A senha precisa de ${PASSWORD_MIN} a ${PASSWORD_MAX} caracteres.`, 400); // não consome o token
    }
    const token = typeof data.token === "string" ? data.token : "";
    const { rows } = await pool.query(
      "DELETE FROM email_tokens WHERE token_hash=$1 AND kind='recover' AND expires>$2 RETURNING user_id", [sha256(token), now()]);
    if (!rows[0]) return failure("Link inválido ou expirado. Peça um novo e-mail de redefinição.", 400);
    await pool.query("UPDATE users SET pass=$1 WHERE id=$2", [await hashPassword(data.password), rows[0].user_id]);
    await pool.query("DELETE FROM sessions WHERE user_id=$1", [rows[0].user_id]);
    return ok({ ok: true, message: "Senha redefinida. Entre com a senha nova." });
  }

  async function resend(data, ctx) {
    if (!pow.verify(data.pow)) return failure("Verificação anti-robô inválida ou expirada. Tente de novo.", 403);
    const at = now();
    if (await blocked("recover", ctx.ip, at)) return failure("Muitos pedidos deste endereço. Tente mais tarde.", 429);
    await record("recover", ctx.ip, limits.recoverIp, at);
    const user = (await pool.query("SELECT * FROM users WHERE email=$1 AND confirmed IS NULL", [normalizeEmail(data.email)])).rows[0];
    if (user) await sendConfirm(user);
    return ok({ ok: true, message: "Se a conta estiver aguardando confirmação, enviaremos um novo e-mail." });
  }

  // Só existe com SAIL_ENV=test (ambiente de teste): confirma a conta sem passar pelo e-mail,
  // para o teste ponta a ponta (deploy/e2e.mjs) conseguir entrar.
  async function testConfirm(data) {
    if (!testMode) return failure("Ação indisponível.", 404);
    const { rowCount } = await pool.query("UPDATE users SET confirmed=$1 WHERE email=$2 AND confirmed IS NULL",
      [now(), normalizeEmail(data.email)]);
    if (!rowCount) return failure("Conta não encontrada ou já confirmada.", 404);
    return ok({ ok: true });
  }

  const actions = {
    challenge: async () => ok(pow.issue()),
    signup, confirm, login, recover, reset, resend, "test-confirm": testConfirm,
    logout: (data, ctx) => logout(ctx),
    "logout-all": (data, ctx) => logoutAll(ctx)
  };

  const handle = (action, data, ctx = {}) =>
    (actions[action] ?? (() => failure("Ação indisponível.", 404)))(data, ctx);

  return { handle, session, tokenFrom, cookieFor, clearCookie };
}
