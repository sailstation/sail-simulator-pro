import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";

test("scripts de deploy/ são executáveis (systemd recusa ExecStart sem permissão de execução)", () => {
  for (const file of readdirSync("deploy").filter((f) => f.endsWith(".sh"))) {
    const mode = statSync(`deploy/${file}`).mode;
    assert.ok(mode & 0o100, `deploy/${file} sem permissão de execução`);
  }
});
