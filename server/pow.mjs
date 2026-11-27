// Captcha próprio por prova de trabalho (ADR-0005), sem serviços de terceiros.
// O desafio é `id.expiração.dificuldade`, assinado com HMAC-SHA256 (segredo em SAIL_POW_SECRET).
// O cliente procura um nonce tal que sha256("desafio.nonce") tenha `dificuldade` bits zero à
// esquerda; o servidor confere assinatura, validade, dificuldade e uso único em uma única hash.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Bits zero à esquerda de um digest (mesma conta do verificador no navegador).
export function leadingZeroBits(digest) {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function createPow({ secret, bits = 16, ttlMs = 5 * 60_000, now = () => Date.now() } = {}) {
  if (!Number.isInteger(bits) || bits < 1 || bits > 32) throw new Error("Dificuldade inválida: use de 1 a 32 bits.");
  const key = secret || randomBytes(32);
  const sign = challenge => createHmac("sha256", key).update("pow." + challenge).digest();
  const used = new Map(); // id do desafio resolvido -> expiração; um desafio vale uma única vez

  function purge(at) {
    for (const [id, expires] of used) if (expires <= at) used.delete(id);
  }

  function issue() {
    purge(now());
    const challenge = `${randomBytes(16).toString("hex")}.${now() + ttlMs}.${bits}`;
    return { challenge, signature: sign(challenge).toString("hex") };
  }

  function verify(solution) {
    const { challenge, signature, nonce } = solution ?? {};
    if (typeof challenge !== "string" || typeof signature !== "string" || !/^\d{1,12}$/.test(String(nonce ?? ""))) return false;
    const parts = challenge.split(".");
    if (parts.length !== 3 || !/^[0-9a-f]{32}$/.test(parts[0]) || !/^\d+$/.test(parts[2])) return false;
    const at = now();
    const expires = Number(parts[1]);
    if (!Number.isSafeInteger(expires) || expires <= at) return false;
    const expected = sign(challenge);
    const given = Buffer.from(signature, "hex");
    if (given.length !== expected.length || !timingSafeEqual(expected, given)) return false;
    if (used.has(parts[0])) return false;
    const digest = createHash("sha256").update(`${challenge}.${nonce}`).digest();
    if (leadingZeroBits(digest) < Number(parts[2])) return false;
    used.set(parts[0], expires);
    return true;
  }

  return { issue, verify, bits };
}
