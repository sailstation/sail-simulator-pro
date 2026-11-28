/* Tela de perfil (ADR-0006): nome de exibição, país (ISO 3166-1 alfa-2 com nomes do
   Intl.DisplayNames e bandeiras Twemoji servidas pelo próprio site — bandeiras.js) e clube
   (busca na lista, ou sugestão que fica pendente até a moderação). A foto é opcional: sem ela,
   o avatar é um emoji da lista curada servida pelo servidor. Sem perfil completo o servidor
   não libera o jogo. */
"use strict";

const el = id => document.getElementById(id);
let clubes = [];          // códigos ISO vindos do servidor
let escolhido = null;     // clube selecionado {id, name, city, country, status}
let fotoAtual = null;     // photoAt da foto já gravada
let emojiEscolhido = "⛵"; // emoji do avatar (padrão do servidor)

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

const countryNames = new Intl.DisplayNames(["pt-BR"], { type: "region" });

// <option> não aceita imagem: o rótulo leva o código ("BR · Brasil") e a bandeira aparece
// como pré-visualização ao lado do campo (bandeiras.js, Twemoji CC-BY 4.0).
function fillCountries() {
  const select = el("pais");
  const options = clubes
    .map(code => ({ code, name: countryNames.of(code) || code }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  select.replaceChildren(new Option("Escolha o país…", ""));
  for (const { code, name } of options) select.add(new Option(bandeiraRotulo(code, name), code));
  const mostrarBandeira = () => {
    const alvo = el("pais-bandeira");
    alvo.replaceChildren(...(select.value ? [bandeira(select.value)] : []));
  };
  select.addEventListener("change", mostrarBandeira);
  mostrarBandeira();
}

// Pré-visualização do avatar: a foto gravada quando existe; sem ela, o emoji escolhido.
function preview() {
  const img = el("foto-atual");
  const vazio = el("foto-vazia");
  el("remover-foto").hidden = !fotoAtual;
  if (fotoAtual) {
    img.src = "/api/profile/photo?t=" + fotoAtual;
    img.hidden = false;
    vazio.hidden = true;
  } else {
    img.hidden = true;
    vazio.hidden = false;
    vazio.textContent = emojiEscolhido;
  }
}

function fillEmojis(emojis) {
  const grid = el("emoji-grade");
  grid.replaceChildren(...emojis.map(emoji => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(emoji === emojiEscolhido));
    button.setAttribute("aria-label", "Avatar " + emoji);
    button.addEventListener("click", () => {
      emojiEscolhido = emoji;
      for (const other of grid.children) other.setAttribute("aria-selected", String(other === button));
      if (!fotoAtual) preview();
    });
    return button;
  }));
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

// Reencoda a foto no navegador antes do envio (ADR-0006): o canvas grava a orientação EXIF
// nos próprios pixels — o servidor remove os metadados e a orientação se perderia junto.
// Sem suporte a canvas/createImageBitmap, envia o arquivo original (o servidor ainda limpa
// os metadados; só a orientação pode se perder).
async function normalizedPhoto(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.92));
    return blob || file;
  } catch {
    return file;
  }
}

async function uploadPhoto(file) {
  const photo = await normalizedPhoto(file);
  const response = await fetch("/api/profile/photo", {
    method: "POST", headers: { "Content-Type": photo.type || file.type }, body: photo
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Não foi possível enviar a foto.");
  return data;
}

el("foto").addEventListener("change", () => {
  const file = el("foto").files[0];
  if (!file) return;
  const img = el("foto-atual");
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  el("foto-vazia").hidden = true;
});

el("remover-foto").addEventListener("click", async () => {
  message("");
  try {
    const [ok, data] = await api("remove-photo");
    if (!ok) throw new Error(data.error);
    fotoAtual = null;
    el("foto").value = "";
    preview();
    message("Foto removida. Seu avatar agora é o emoji escolhido.");
  } catch (error) { message(error.message || "Algo deu errado. Tente de novo.", true); }
});

el("form-perfil").addEventListener("submit", async event => {
  event.preventDefault();
  message("");
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    if (!escolhido) throw new Error("Escolha o seu clube na busca (ou sugira um novo).");
    const [ok, data] = await api("save", {
      name: el("nome").value, country: el("pais").value, clubId: escolhido.id, emoji: emojiEscolhido
    });
    if (!ok) throw new Error(data.error);
    const file = el("foto").files[0];
    if (file) {
      const enviada = await uploadPhoto(file);
      fotoAtual = enviada.photoAt;
    }
    const [, state] = await api("get");
    if (!state.complete) throw new Error("Perfil incompleto: confira nome, país e clube.");
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
  const [okAvatares, avatares] = await api("avatars");
  if (!okAvatares) throw new Error(avatares.error || "Não foi possível carregar os avatares.");
  const [okPerfil, data] = await api("get");
  if (!okPerfil) throw new Error(data.error || "Não foi possível carregar o perfil.");
  if (data.profile) {
    el("nome").value = data.profile.name;
    el("pais").value = data.profile.country;
    el("pais").dispatchEvent(new Event("change")); // atualiza a prévia da bandeira
    choose(data.profile.club);
    if (data.profile.emoji) emojiEscolhido = data.profile.emoji;
    if (data.profile.photoAt) fotoAtual = data.profile.photoAt;
  }
  fillEmojis(avatares.emojis);
  preview();
}
load().catch(error => message(error.message, true));
