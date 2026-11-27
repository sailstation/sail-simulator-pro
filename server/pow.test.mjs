// Testes do captcha por prova de trabalho (ADR-0005). Dificuldade baixa para rodar rápido.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPow, leadingZeroBits } from "./pow.mjs";

const hash = text => createHash("sha256").update(text).digest();

function solve(pow) {
  const { challenge, signature } = pow.issue();
  const bits = Number(challenge.split(".")[2]);
  for (let nonce = 0; ; nonce++) if (leadingZeroBits(hash(`${challenge}.${nonce}`)) >= bits) return { challenge, signature, nonce };
}

test("leadingZeroBits conta os bits zero à esquerda do digest", () => {
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0x80])), 16);
  assert.equal(leadingZeroBits(Buffer.from([0x01])), 7);
  assert.equal(leadingZeroBits(Buffer.from([0x0f])), 4);
  assert.equal(leadingZeroBits(Buffer.from([0xff])), 0);
  assert.equal(leadingZeroBits(Buffer.alloc(0)), 0);
});

test("desafio resolvido é aceito uma única vez", () => {
  const pow = createPow({ secret: "s", bits: 8 });
  const solution = solve(pow);
  assert.equal(pow.verify(solution), true);
  assert.equal(pow.verify(solution), false, "mesmo desafio não vale duas vezes");
});

test("nonce errado, assinatura adulterada e formato inválido são recusados", () => {
  const pow = createPow({ secret: "s", bits: 8 });
  const good = solve(pow);
  assert.equal(pow.verify({ ...good, nonce: good.nonce + 1_000_003 }), false, "nonce que não resolve");
  assert.equal(pow.verify({ ...good, signature: good.signature.replace(/../, "00") }), false, "assinatura adulterada");
  assert.equal(pow.verify({ ...good, signature: "zz" }), false, "assinatura não-hex");
  assert.equal(pow.verify({ ...good, signature: good.signature.slice(2) }), false, "assinatura curta");
  assert.equal(pow.verify(null), false);
  assert.equal(pow.verify({}), false);
  assert.equal(pow.verify({ ...good, nonce: "abc" }), false, "nonce não numérico");
  assert.equal(pow.verify({ ...good, nonce: "1".repeat(13) }), false, "nonce longo demais");
  assert.equal(pow.verify({ ...good, challenge: "sem-formato" }), false, "desafio malformado");
  assert.equal(pow.verify({ ...good, challenge: good.challenge.replace(/^../, "zz") }), false, "id fora do formato");
  assert.equal(pow.verify({ ...good, challenge: `${good.challenge}.extra` }), false, "desafio com parte extra");
});

test("desafio expirado é recusado e desafios de outro segredo não valem", () => {
  let clock = 1_000_000;
  const pow = createPow({ secret: "s", bits: 8, ttlMs: 60_000, now: () => clock });
  const solution = solve(pow);
  clock += 61_000;
  assert.equal(pow.verify(solution), false, "expirado");
  clock -= 61_000;
  const outro = createPow({ secret: "outro", bits: 8, now: () => clock });
  assert.equal(outro.verify(solution), false, "assinado com outro segredo");
});

test("desafio já usado não volta a valer mesmo dentro da validade", () => {
  let clock = 0;
  const pow = createPow({ secret: "s", bits: 1, now: () => clock });
  const a = solve(pow);
  assert.equal(pow.verify(a), true);
  clock += 1000;
  assert.equal(pow.verify(a), false);
});

test("sem segredo configurado, um segredo aleatório por instância é usado", () => {
  const a = createPow({ bits: 4 });
  const b = createPow({ bits: 4 });
  const solution = solve(a);
  assert.equal(a.verify(solution), true);
  assert.equal(b.verify(solve(a)), false, "instâncias não compartilham segredo");
});

test("dificuldade fora de 1..32 é recusada na configuração", () => {
  assert.throws(() => createPow({ bits: 0 }), /Dificuldade/);
  assert.throws(() => createPow({ bits: 33 }), /Dificuldade/);
  assert.throws(() => createPow({ bits: 1.5 }), /Dificuldade/);
});

test("a dificuldade vem assinada no desafio: menos bits que o pedido não passa", () => {
  const pow = createPow({ secret: "s", bits: 12 });
  const solution = solve(pow);
  // Forja um desafio com dificuldade 1 mantendo a assinatura do desafio de 12 bits.
  const [id, expires] = solution.challenge.split(".");
  assert.equal(pow.verify({ ...solution, challenge: `${id}.${expires}.1` }), false, "assinatura não cobre a alteração");
});
