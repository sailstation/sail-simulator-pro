import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const read = file => readFileSync(file, "utf8");
const localLinks = text => [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map(m => m[1]).filter(l => !/^[a-z]+:/i.test(l));

test("arquivos de instrução de cada IA apontam para o AGENTS.md", () => {
  for (const file of ["CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md", ".cursor/rules/agents.mdc"]) {
    assert.ok(existsSync(file), `${file} ausente`);
    assert.match(read(file), /AGENTS\.md/, `${file} não aponta para AGENTS.md`);
  }
});

test("links locais do AGENTS.md, README e índice de ADRs existem", () => {
  for (const [file, base] of [["AGENTS.md", ""], ["README.md", ""], ["docs/adr/README.md", "docs/adr/"]]) {
    for (const link of localLinks(read(file))) assert.ok(existsSync(base + link), `${file}: link quebrado ${link}`);
  }
});

test("todo ADR está no índice, com número único e estado declarado", () => {
  const index = read("docs/adr/README.md");
  const adrs = readdirSync("docs/adr").filter(f => /^\d{4}-.+\.md$/.test(f));
  const numbers = adrs.map(f => f.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, "número de ADR repetido");
  for (const file of adrs) {
    assert.ok(index.includes(`](${file})`), `${file} não está em docs/adr/README.md`);
    assert.match(read(`docs/adr/${file}`), /^Estado: /m, `${file} sem linha "Estado:"`);
  }
});

test("AGENTS.md registra a proibição de Docker e contêineres", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /Não use Docker nem qualquer contêiner/, "AGENTS.md sem a regra que proíbe Docker e contêineres");
});

test("nenhum workflow do GitHub Actions usa Docker ou contêineres", () => {
  const dir = ".github/workflows";
  for (const file of readdirSync(dir)) {
    const text = read(`${dir}/${file}`);
    assert.doesNotMatch(text, /^\s*(services|container):/m, `${file}: services:/container: proibido`);
    assert.doesNotMatch(text, /docker/i, `${file}: menção a docker proibida`);
  }
});
