// Bandeiras Twemoji auto-hospedadas (ADR-0006, ajuste de 28/11/2026): todo código ISO 3166-1
// alfa-2 aceito pelo servidor precisa de um PNG válido em dist/flags/, e as telas que exibem
// bandeiras precisam carregar o helper e exibir a atribuição exigida pela CC-BY 4.0.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COUNTRY_CODES } from "../server/countries.mjs";
import { loadAssets } from "../server/main.mjs";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("todo código ISO da lista do servidor tem bandeira PNG válida em dist/flags", async () => {
  const missing = [];
  for (const code of COUNTRY_CODES) {
    try {
      const data = await readFile(new URL(`../dist/flags/${code.toLowerCase()}.png`, import.meta.url));
      assert.ok(data.subarray(0, 8).equals(PNG_MAGIC), `${code}: arquivo não é PNG`);
    } catch (error) {
      if (error.code === "ENOENT") missing.push(code);
      else throw error;
    }
  }
  assert.deepEqual(missing, [], `códigos sem bandeira: ${missing.join(" ")}`);
});

test("as telas com bandeira carregam o helper e exibem a atribuição Twemoji (CC-BY 4.0)", async () => {
  for (const page of ["perfil.html", "equipe.html"]) {
    const html = await readFile(new URL(`../dist/${page}`, import.meta.url), "utf8");
    assert.match(html, /<script src="bandeiras\.js" defer><\/script>/, `${page} sem bandeiras.js`);
    assert.match(html, /Twemoji/, `${page} sem atribuição Twemoji`);
    assert.match(html, /CC-BY 4\.0/, `${page} sem a licença na atribuição`);
  }
});

test("o servidor expõe as bandeiras como estáticos (/flags/<cc>.png)", () => {
  const assets = loadAssets();
  const entry = assets["/flags/br.png"];
  assert.ok(entry, "loadAssets não expõe /flags/br.png");
  assert.equal(entry[0], "image/png");
  assert.ok(entry[2].subarray(0, 8).equals(PNG_MAGIC));
});

test("nenhuma tela monta bandeira por emoji Unicode (não renderiza no Chrome/Windows)", async () => {
  for (const script of ["perfil.js", "equipe.js"]) {
    const source = await readFile(new URL(`../dist/${script}`, import.meta.url), "utf8");
    assert.ok(!source.includes("0x1F1E6"), `${script} ainda monta emoji de bandeira`);
  }
});
