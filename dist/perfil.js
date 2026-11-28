/* Tela de perfil (ADR-0006): foto, nome de exibição, país (ISO 3166-1 alfa-2 com nomes do
   Intl.DisplayNames e bandeiras emoji do sistema) e clube (busca na lista, ou sugestão que
   fica pendente até a moderação). Sem perfil completo o servidor não libera o jogo. */
"use strict";

const el = id => document.getElementById(id);
let clubes = [];          // códigos ISO vindos do servidor
let escolhido = null;     // clube selecionado {id, name, city, country, status}
let fotoAtual = null;     // photoAt da foto já gravada

function message(text, isError = false) {
  const box = el("mensagem");
  box.hidden = !text;
  box.classList.toggle("erro", isError);
  box.textContent = text || "";
}
async function api(action, body) {
  const response = await fetch("/api/profile/" + action, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {})
  });
  if (response.status === 401) { location.assign("/login.html"); throw new Error("Sessão expirada."); }
  const data = await response.json().catch(() => ({}));
  return [response.ok, data];
}

// Bandeira como emoji Unicode (indicadores regionais): sem assets nem chamadas externas.
const flag = code => String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
const countryNames = new Intl.DisplayNames(["pt-BR"], { type: "region" });

function fillCountries() {
  const select = el("pais");
  const options = clubes
    .map(code => ({ code, name: countryNames.of(code) || code }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  select.replaceChildren(new Option("Escolha o país…", ""));
  for (const { code, name } of options) select.add(new Option(`${flag(code)} ${name}`, code));
}

function clubLabel(club) {
  const where = [club.city, countryNames.of(club.country) || club.country].filter(Boolean).join(" · ");
  return { title: club.name, detail: where + (club.status === "pending" ? " · pendente de moderação" : "") };
}
function choose(club) {
  escolhido = club;
  const { title, detail } = clubLabel(club);
  const box = el("clube-escolhido");
  box.hidden = false;
  box.textContent = `Clube escolhido: ${title}${detail ? " — " + detail : ""}`;
  el("clube-resultados").replaceChildren();
  el("clube-busca").value = "";
  el("sugestao").hidden = true;
}

async function searchClubs() {
  const query = el("clube-busca").value.trim();
  const list = el("clube-resultados");
  if (query.length < 2) { list.replaceChildren(); return; }
  const [ok, data] = await api("clubs/search", { query });
  if (!ok) { message(data.error, true); return; }
  const items = data.clubs.map(club => {
    const item = document.createElement("li");
    const { title, detail } = clubLabel(club);
    item.textContent = title;
    if (detail) {
      const small = document.createElement("small");
      small.textContent = detail;
      item.append(small);
    }
    item.addEventListener("click", () => choose(club));
    return item;
  });
  if (!items.length) {
    const item = document.createElement("li");
    item.textContent = "Nenhum clube encontrado. Você pode sugerir o cadastro abaixo.";
    items.push(item);
  }
  list.replaceChildren(...items);
}
let searchTimer = null;
el("clube-busca").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchClubs().catch(() => {}), 300);
});

el("botao-sugerir").addEventListener("click", () => {
  el("sugestao").hidden = !el("sugestao").hidden;
});
el("sugestao-enviar").addEventListener("click", async () => {
  message("");
  try {
    const [ok, data] = await api("clubs/suggest", {
      name: el("sugestao-nome").value, country: el("pais").value, city: el("sugestao-cidade").value
    });
    if (!ok) throw new Error(data.error);
    choose(data.club);
    message(data.existing ? "Esse clube já estava na lista; selecionamos ele para você."
      : "Sugestão enviada. Ela fica pendente até a moderação e, por enquanto, só aparece para você.");
  } catch (error) { message(error.message || "Algo deu errado. Tente de novo.", true); }
});

async function uploadPhoto(file) {
  const response = await fetch("/api/profile/photo", {
    method: "POST", headers: { "Content-Type": file.type }, body: file
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Não foi possível enviar a foto.");
  return data;
}

el("foto").addEventListener("change", () => {
  const file = el("foto").files[0];
  if (!file) return;
  const preview = el("foto-atual");
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  el("foto-vazia").hidden = true;
});

el("form-perfil").addEventListener("submit", async event => {
  event.preventDefault();
  message("");
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    if (!escolhido) throw new Error("Escolha o seu clube na busca (ou sugira um novo).");
    const [ok, data] = await api("save", {
      name: el("nome").value, country: el("pais").value, clubId: escolhido.id
    });
    if (!ok) throw new Error(data.error);
    const file = el("foto").files[0];
    if (file) await uploadPhoto(file);
    const [, state] = await api("get");
    if (!state.complete) throw new Error("Falta a foto: envie uma imagem JPEG, PNG ou WebP de até 2 MB.");
    location.assign("/");
  } catch (error) {
    message(error.message || "Algo deu errado. Tente de novo.", true);
  } finally {
    button.disabled = false;
  }
});

el("botao-sair").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  location.assign("/login.html");
});

async function load() {
  const [okPaises, paises] = await api("countries");
  if (!okPaises) throw new Error(paises.error || "Não foi possível carregar a lista de países.");
  clubes = paises.countries;
  fillCountries();
  const [okPerfil, data] = await api("get");
  if (!okPerfil) throw new Error(data.error || "Não foi possível carregar o perfil.");
  if (data.profile) {
    el("nome").value = data.profile.name;
    el("pais").value = data.profile.country;
    choose(data.profile.club);
    if (data.profile.photoAt) {
      fotoAtual = data.profile.photoAt;
      const preview = el("foto-atual");
      preview.src = "/api/profile/photo?t=" + fotoAtual;
      preview.hidden = false;
      el("foto-vazia").hidden = true;
    }
  }
}
load().catch(error => message(error.message, true));
