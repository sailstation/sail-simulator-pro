// Testa a detecção de formato de release usada pelo deploy (deploy/release-format.sh, ADR-0004).
// Roda em qualquer árvore (legada ou nativa): usa árvores sintéticas em diretório temporário.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../deploy/release-format.sh", import.meta.url));

const format = dir => execFileSync("bash", [SCRIPT, dir], { encoding: "utf8" }).trim();
const ready = dir => {
  try {
    execFileSync("bash", [SCRIPT, "--pronta", dir]);
    return true;
  } catch {
    return false;
  }
};

const tree = files => {
  const dir = mkdtempSync(path.join(tmpdir(), "sail-format-"));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), "//\n");
  }
  return dir;
};

const LEGADO = ["worker/index.js", "scripts/build-site.mjs", "package.json"];
const NATIVO = ["server/main.mjs", "server/db.mjs", "package.json", "package-lock.json"];

test("árvore legada (worker + build-site, sem lockfile) é reconhecida como legado", t => {
  const dir = tree(LEGADO);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(format(dir), "legado");
});

test("árvore nativa (server/main.mjs + package-lock.json) é reconhecida como nativo", t => {
  const dir = tree(NATIVO);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(format(dir), "nativo");
});

test("server/main.mjs sem lockfile não é nativo (npm ci falharia); cai no caminho legado", t => {
  const dir = tree([...LEGADO, "server/main.mjs"]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(format(dir), "legado");
});

test("release legada só está pronta depois do build (dist/server/index.js)", t => {
  const dir = tree(LEGADO);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(ready(dir), false);
  mkdirSync(path.join(dir, "dist/server"), { recursive: true });
  writeFileSync(path.join(dir, "dist/server/index.js"), "//\n");
  assert.equal(ready(dir), true);
});

test("release nativa está pronta assim que a árvore é extraída", t => {
  const dir = tree(NATIVO);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(ready(dir), true);
});

test("sem argumentos ou com diretório inexistente o script falha", () => {
  assert.throws(() => execFileSync("bash", [SCRIPT]));
  // Diretório inexistente não é erro de execução: sem os arquivos, é legado não pronto.
  assert.equal(format("/nao/existe"), "legado");
  assert.equal(ready("/nao/existe"), false);
});
