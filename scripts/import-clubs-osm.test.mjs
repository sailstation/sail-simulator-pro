// Testes do importador offline de clubes do OpenStreetMap (ADR-0006). Sem banco e sem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clubsFromExtract, toSql } from "./import-clubs-osm.mjs";

const SCRIPT = fileURLToPath(new URL("./import-clubs-osm.mjs", import.meta.url));

const EXTRACT = {
  elements: [
    { type: "node", id: 101, tags: { leisure: "sailing_club", name: "Clube A", "addr:country": "br", "addr:city": "Paraty" } },
    { type: "way", id: 202, tags: { club: "sailing", name: "Clube do Mar", "addr:country": "PT" } },
    { type: "node", id: 303, tags: { leisure: "sailing_club", name: "O'Brien Sailing" } },       // sem país
    { type: "node", id: 404, tags: { leisure: "sailing_club" } },                                // sem nome
    { type: "node", id: 505, tags: { amenity: "cafe", name: "Café da Marina" } },                // não é clube
    { type: "way", id: 202, tags: { club: "sailing", name: "Clube do Mar", "addr:country": "PT" } }, // duplicado
  ]
};

test("extrai só clubes de vela, com país validado e ordenação por nome", () => {
  const { clubs, skipped } = clubsFromExtract(EXTRACT);
  assert.deepEqual(clubs.map(c => c.name), ["Clube A", "Clube do Mar"]);
  assert.deepEqual(clubs[0], { id: "osm-node-101", name: "Clube A", country: "BR", city: "Paraty" });
  assert.equal(clubs[1].city, null);
  assert.deepEqual(skipped, { notClub: 1, semNome: 1, semPais: 1, duplicado: 1 });
});

test("país de reserva (--country) cobre extrato sem addr:country, sem sobrescrever o das tags", () => {
  const { clubs } = clubsFromExtract(EXTRACT, { fallbackCountry: "AR" });
  const obrien = clubs.find(c => c.name === "O'Brien Sailing");
  assert.equal(obrien.country, "AR");
  assert.equal(clubs.find(c => c.name === "Clube A").country, "BR");
});

test("extrato malformado é recusado com erro claro", () => {
  assert.throws(() => clubsFromExtract({}), /elements/);
  assert.throws(() => clubsFromExtract(null), /elements/);
});

test("SQL gerado carrega atribuição ODbL, escapa aspas e não duplica em nova aplicação", () => {
  const { clubs } = clubsFromExtract({ elements: [{ type: "node", id: 1, tags: { club: "sailing", name: "O'Brien Sailing", "addr:country": "IE" } }] });
  const sql = toSql(clubs, { source: "teste", appliedAt: 123 });
  assert.match(sql, /© OpenStreetMap contributors/);
  assert.match(sql, /ODbL 1\.0/);
  assert.match(sql, /'O''Brien Sailing'/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(sql, /'approved', 'osm', false, 123/);
  assert.match(toSql([], {}), /Nenhum clube/);
});

test("linha de comando: gera SQL a partir de um arquivo e falha sem extrato", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sail-osm-"));
  const file = path.join(dir, "extrato.json");
  writeFileSync(file, JSON.stringify(EXTRACT));
  const sql = execFileSync(process.execPath, [SCRIPT, file, "--fonte", "extrato de teste"], { encoding: "utf8" });
  assert.match(sql, /INSERT INTO clubs/);
  assert.match(sql, /extrato de teste/);
  assert.throws(() => execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", stdio: "pipe" }));
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, file, "--country", "BRZ"], { encoding: "utf8", stdio: "pipe" }));
  const ruim = path.join(dir, "ruim.json");
  writeFileSync(ruim, "{");
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, ruim], { encoding: "utf8", stdio: "pipe" }));
});
