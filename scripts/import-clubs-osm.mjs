// Importador offline de clubes de vela do OpenStreetMap (ADR-0006, issue #33).
// Lê um extrato JSON do Overpass (nós e caminhos com leisure=sailing_club ou club=sailing)
// e emite SQL na saída padrão para revisão humana e aplicação manual no banco.
// NÃO roda no deploy nem em tempo de execução: é uma ferramenta de manutenção da base.
//
// Licença dos dados: Open Database License (ODbL) 1.0 — © OpenStreetMap contributors.
// O SQL gerado carrega a atribuição exigida; confirme a compatibilidade da ODbL (atribuição e
// compartilhamento pela igualdade da base derivada) antes da primeira importação real.
//
// Uso:
//   node scripts/import-clubs-osm.mjs extrato.json [--country BR] > clubes.sql
// O extrato sai do Overpass, por exemplo:
//   [out:json];(nwr["leisure"="sailing_club"];nwr["club"="sailing"];);out tags;
import { readFileSync } from "node:fs";
import { normalizeCountry } from "../server/countries.mjs";

const isSailingClub = tags =>
  tags.leisure === "sailing_club" || tags.club === "sailing";

const sqlText = value => "'" + String(value).replace(/'/g, "''") + "'";

export function clubsFromExtract(extract, { fallbackCountry = null } = {}) {
  const elements = Array.isArray(extract) ? extract : extract?.elements;
  if (!Array.isArray(elements)) {
    throw new Error("Extrato inválido: esperado JSON do Overpass com o campo elements.");
  }
  const clubs = [];
  const skipped = { notClub: 0, semNome: 0, semPais: 0, duplicado: 0 };
  const seen = new Set();
  for (const element of elements) {
    const tags = element?.tags ?? {};
    if (!isSailingClub(tags)) { skipped.notClub++; continue; }
    const name = typeof tags.name === "string" ? tags.name.trim().replace(/\s+/gu, " ") : "";
    if (name.length < 3 || name.length > 80) { skipped.semNome++; continue; }
    const country = normalizeCountry(tags["addr:country"]) ?? fallbackCountry;
    if (!country) { skipped.semPais++; continue; }
    const id = `osm-${element.type}-${element.id}`;
    if (seen.has(id)) { skipped.duplicado++; continue; }
    seen.add(id);
    const city = typeof tags["addr:city"] === "string" ? tags["addr:city"].trim().slice(0, 80) : "";
    clubs.push({ id, name, country, city: city || null });
  }
  clubs.sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id));
  return { clubs, skipped };
}

export function toSql(clubs, { source = "extrato Overpass do OpenStreetMap", appliedAt = Date.now() } = {}) {
  const header = [
    "-- Clubes de vela importados do OpenStreetMap (ADR-0006).",
    `-- Fonte: ${source}`,
    "-- Licença: ODbL 1.0 — © OpenStreetMap contributors (https://www.openstreetmap.org/copyright).",
    "-- Revise antes de aplicar; os dados entram como verified=false (\"a verificar\").",
  ].join("\n");
  const rows = clubs.map(club =>
    `  (${sqlText(club.id)}, ${sqlText(club.name)}, ${sqlText(club.country)}, ` +
    `${club.city === null ? "NULL" : sqlText(club.city)}, 'approved', 'osm', false, ${appliedAt})`);
  const body = rows.length === 0
    ? "-- Nenhum clube no extrato."
    : "INSERT INTO clubs (id, name, country, city, status, source, verified, created) VALUES\n" +
      rows.join(",\n") + "\nON CONFLICT (id) DO NOTHING;";
  return header + "\n" + body + "\n";
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const args = process.argv.slice(2);
  const file = args.find(arg => !arg.startsWith("--"));
  const flag = name => {
    const at = args.indexOf("--" + name);
    return at === -1 ? null : args[at + 1];
  };
  if (!file) {
    console.error("uso: node scripts/import-clubs-osm.mjs <extrato.json> [--country BR] [--fonte \"descrição da fonte\"]");
    process.exit(1);
  }
  const fallback = flag("country") ? normalizeCountry(flag("country")) : null;
  if (flag("country") && !fallback) {
    console.error(`--country inválido: ${flag("country")} (use ISO 3166-1 alfa-2, ex.: BR)`);
    process.exit(1);
  }
  let extract;
  try {
    extract = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Não foi possível ler o extrato: ${error.message}`);
    process.exit(1);
  }
  const { clubs, skipped } = clubsFromExtract(extract, { fallbackCountry: fallback });
  process.stdout.write(toSql(clubs, { source: flag("fonte") ?? `extrato ${file}` }));
  console.error(`${clubs.length} clubes; ignorados: ${skipped.notClub} sem tag de clube de vela, ` +
    `${skipped.semNome} sem nome utilizável, ${skipped.semPais} sem país, ${skipped.duplicado} duplicados.`);
}
