/* Tela de equipes (ADR-0007): criar equipe, convites (nome, e-mail e link), papéis de
   capitão e membro e o chat da equipe com polling (after) e histórico paginado (before).
   Todo texto é renderizado com textContent — mensagens nunca viram HTML. */
"use strict";

const el = id => document.getElementById(id);
let estado = null;          // resposta do teams/get
let selecionada = null;     // id da equipe aberta
let mensagens = [];         // histórico carregado, em ordem
let temAnteriores = false;
let carregandoChat = false;
let relogio = 0;            // "now" do servidor na última consulta de chat (cursor since)

function message(text, isError = false) {
  const box = el("mensagem");
  box.hidden = !text;
  box.classList.toggle("erro", isError);
  box.textContent = text || "";
}
async function api(action, body) {
  const response = await fetch("/api/teams/" + action, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {})
  });
  if (response.status === 401) { location.assign("/login.html"); throw new Error("Sessão expirada."); }
  if (response.status === 403) {
    const data = await response.json().catch(() => ({}));
    if (/perfil/i.test(data.error || "")) { location.assign("/perfil.html"); throw new Error("Complete o perfil."); }
  }
  const data = await response.json().catch(() => ({}));
  return [response.ok, data];
}

const flag = code => String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
const countryNames = new Intl.DisplayNames(["pt-BR"], { type: "region" });
const hora = ms => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

function avatarNode(avatar) {
  const span = document.createElement("span");
  span.className = "avatar";
  if (avatar && avatar.type === "photo") {
    const img = document.createElement("img");
    img.src = "/api/profile/photo?t=" + avatar.photoAt;
    img.alt = "";
    span.append(img);
  } else {
    span.textContent = avatar && avatar.type === "emoji" ? avatar.emoji : "⛵";
  }
  return span;
}

function teamById(id) { return estado.teams.find(team => team.id === id) || null; }

// --- listas ------------------------------------------------------------------------------------
function renderConvites() {
  const box = el("caixa-convites");
  const list = el("lista-convites");
  box.hidden = !estado.invites.length;
  list.replaceChildren(...estado.invites.map(convite => {
    const item = document.createElement("li");
    const texto = document.createElement("span");
    texto.textContent = `${convite.team.name} (${convite.team.tag})` + (convite.from ? ` — convite de ${convite.from}` : "");
    const aceitar = document.createElement("button");
    aceitar.type = "button";
    aceitar.className = "link";
    aceitar.textContent = "Aceitar";
    aceitar.addEventListener("click", () => responder(convite.id, "accept"));
    const recusar = document.createElement("button");
    recusar.type = "button";
    recusar.className = "link";
    recusar.textContent = "Recusar";
    recusar.addEventListener("click", () => responder(convite.id, "decline"));
    item.append(texto, " ", aceitar, " · ", recusar);
    return item;
  }));
}

async function responder(inviteId, acao) {
  message("");
  const [ok, data] = await api(acao, { inviteId });
  if (!ok) { message(data.error, true); return; }
  await carregar();
  if (acao === "accept") trocarPara(data.teamId);
}

function renderEquipes() {
  const list = el("lista-equipes");
  el("sem-equipes").hidden = estado.teams.length > 0;
  list.replaceChildren(...estado.teams.map(team => {
    const item = document.createElement("li");
    if (team.id === selecionada) item.className = "selecionada";
    const sigla = document.createElement("span");
    sigla.className = "sigla";
    sigla.textContent = team.tag;
    const nome = document.createElement("span");
    nome.textContent = team.name + (team.country ? ` ${flag(team.country)}` : "");
    item.append(sigla, nome);
    const selo = document.createElement("span");
    selo.className = "selo";
    selo.textContent = (team.role === "captain" ? "capitã" : "membro") +
      (team.primary ? " · principal" : "") + ` · ${team.members.length}/${estado.memberLimit}`;
    item.append(selo);
    item.addEventListener("click", () => selecionar(team.id));
    return item;
  }));
}

// --- detalhe da equipe -------------------------------------------------------------------------
function renderDetalhe() {
  const team = teamById(selecionada);
  el("equipe-detalhe").hidden = !team;
  if (!team) return;
  const capitao = team.role === "captain";
  el("detalhe-nome").textContent = `${team.name} (${team.tag})`;
  el("detalhe-info").textContent =
    (team.country ? `${countryNames.of(team.country) || team.country} · ` : "") +
    `${team.members.length} de ${estado.memberLimit} lugares` + (capitao ? " · você é a capitã" : "");
  el("lista-membros").replaceChildren(...team.members.map(membro => {
    const item = document.createElement("li");
    item.className = "membro";
    const dados = document.createElement("span");
    dados.className = "dados";
    dados.textContent = membro.name + (membro.you ? " (você)" : "");
    const selo = document.createElement("span");
    selo.className = "selo";
    selo.textContent = membro.role === "captain" ? "capitã" : "membro";
    item.append(avatarNode(membro.avatar), dados, selo);
    if (capitao && !membro.you) {
      const acoes = document.createElement("span");
      acoes.className = "acoes";
      const transferir = document.createElement("button");
      transferir.type = "button";
      transferir.textContent = "transferir capitania";
      transferir.addEventListener("click", () => agir("transfer", { teamId: team.id, userId: membro.id },
        `Capitania de ${team.name} transferida para ${membro.name}.`));
      const remover = document.createElement("button");
      remover.type = "button";
      remover.textContent = "remover";
      remover.addEventListener("click", () => agir("remove", { teamId: team.id, userId: membro.id },
        `${membro.name} foi removida da equipe.`));
      acoes.append(transferir, remover);
      item.append(acoes);
    }
    return item;
  }));

  el("acoes-capitao").hidden = !capitao;
  el("botao-principal").hidden = team.primary;
  const pendentes = el("convites-pendentes");
  pendentes.hidden = !capitao || !team.invites.length;
  el("lista-pendentes").replaceChildren(...team.invites.map(convite => {
    const item = document.createElement("li");
    const alvo = convite.kind === "link"
      ? `link (${convite.uses}/${convite.maxUses} usos)`
      : convite.to;
    item.textContent = alvo;
    const revogar = document.createElement("button");
    revogar.type = "button";
    revogar.className = "link";
    revogar.textContent = "revogar";
    revogar.addEventListener("click", () => agir("revoke", { teamId: team.id, inviteId: convite.id }, "Convite revogado."));
    item.append(" ", revogar);
    return item;
  }));
}

async function agir(acao, corpo, sucesso) {
  message("");
  const [ok, data] = await api(acao, corpo);
  if (!ok) { message(data.error, true); return; }
  if (sucesso) message(sucesso);
  await carregar();
}

// Único caminho de troca de equipe: zera o chat (mensagens, cursores e tela) antes de abrir
// a nova — sem isso, mensagens de uma equipe apareceriam na outra.
function trocarPara(teamId) {
  selecionada = teamId;
  mensagens = [];
  temAnteriores = false;
  relogio = 0;
  el("chat-mensagens").replaceChildren();
  el("chat-anteriores").hidden = true;
  renderEquipes();
  renderDetalhe();
  carregarChatInicial().catch(() => {});
}

function selecionar(teamId) {
  if (selecionada === teamId) return;
  trocarPara(teamId);
}

// --- chat (polling com after; histórico com before) ---------------------------------------------
function renderMensagem(msg) {
  const item = document.createElement("li");
  item.className = "mensagem" + (msg.deleted ? " apagada" : "");
  item.dataset.id = msg.id;
  const corpo = document.createElement("span");
  corpo.className = "corpo";
  const quem = document.createElement("span");
  quem.className = "quem";
  quem.textContent = msg.user ? msg.user.name : "—";
  const quando = document.createElement("span");
  quando.className = "quando";
  quando.textContent = hora(msg.created);
  const texto = document.createElement("span");
  texto.className = "texto";
  texto.textContent = msg.deleted ? "mensagem apagada" : msg.body;
  corpo.append(quem, quando, document.createElement("br"), texto);
  item.append(avatarNode(msg.user && msg.user.avatar), corpo);
  const team = teamById(selecionada);
  if (!msg.deleted && team) {
    const acoes = document.createElement("span");
    acoes.className = "acoes";
    if (msg.mine || team.role === "captain") {
      const apagar = document.createElement("button");
      apagar.type = "button";
      apagar.textContent = "apagar";
      apagar.addEventListener("click", async () => {
        const [ok, data] = await api("delete-message", { teamId: team.id, messageId: msg.id });
        if (!ok) { message(data.error, true); return; }
        aplicarLote([data.message]); // vira tombstone também na própria tela
      });
      acoes.append(apagar);
    }
    if (!msg.mine) {
      const denunciar = document.createElement("button");
      denunciar.type = "button";
      denunciar.textContent = "denunciar";
      denunciar.addEventListener("click", async () => {
        const motivo = prompt("Motivo da denúncia (a moderação recebe uma cópia da mensagem):");
        if (motivo === null) return;
        const [ok, data] = await api("report", { teamId: team.id, messageId: msg.id, reason: motivo });
        message(ok ? data.message : data.error, !ok);
      });
      acoes.append(denunciar);
    }
    if (acoes.children.length) item.append(acoes);
  }
  return item;
}

// Aplica o lote na tela: novas entram no fim; tombstones atualizam quem já estava lá.
function aplicarLote(lote) {
  const porId = new Map(mensagens.map((msg, i) => [msg.id, i]));
  for (const msg of lote) {
    const existente = porId.get(msg.id);
    if (existente !== undefined) {
      if (msg.deleted && !mensagens[existente].deleted) {
        mensagens[existente] = msg;
        const node = el("chat-mensagens").querySelector(`[data-id="${msg.id}"]`);
        if (node) node.replaceWith(renderMensagem(msg));
      }
      continue;
    }
    mensagens.push(msg);
    porId.set(msg.id, mensagens.length - 1);
    const lista = el("chat-mensagens");
    const noFim = lista.scrollTop + lista.clientHeight >= lista.scrollHeight - 40;
    lista.append(renderMensagem(msg));
    if (noFim) lista.scrollTop = lista.scrollHeight;
  }
}

async function carregarChatInicial() {
  const teamId = selecionada;
  if (!teamId || carregandoChat) return;
  carregandoChat = true;
  try {
    const [ok, data] = await api("chat", { teamId });
    if (selecionada !== teamId) return; // trocou de equipe com a resposta em voo: descarta
    if (!ok) { message(data.error, true); return; }
    mensagens = [];
    el("chat-mensagens").replaceChildren();
    aplicarLote(data.messages);
    relogio = data.now;
    temAnteriores = data.hasMore;
    el("chat-anteriores").hidden = !temAnteriores;
    const lista = el("chat-mensagens");
    lista.scrollTop = lista.scrollHeight;
  } finally { carregandoChat = false; }
}

async function carregarAnteriores() {
  const teamId = selecionada;
  if (!teamId || !mensagens.length) return;
  const [ok, data] = await api("chat", { teamId, before: mensagens[0].id });
  if (selecionada !== teamId) return;
  if (!ok) { message(data.error, true); return; }
  const lista = el("chat-mensagens");
  const altura = lista.scrollHeight;
  const novos = data.messages.filter(msg => !mensagens.some(m => m.id === msg.id));
  mensagens = [...novos, ...mensagens];
  lista.prepend(...novos.map(renderMensagem));
  lista.scrollTop += lista.scrollHeight - altura;
  temAnteriores = data.hasMore;
  el("chat-anteriores").hidden = !temAnteriores;
}

el("chat-anteriores").addEventListener("click", () => carregarAnteriores().catch(() => {}));

async function polling() {
  const teamId = selecionada;
  if (carregandoChat || document.hidden || !teamId || !teamById(teamId)) return;
  carregandoChat = true;
  try {
    const ultimo = mensagens.length ? mensagens[mensagens.length - 1].id : 0;
    const [ok, data] = await api("chat", { teamId, after: ultimo, since: relogio });
    if (!ok || selecionada !== teamId) return;
    relogio = data.now;
    aplicarLote(data.messages);
  } catch { /* rede instável: a próxima rodada tenta de novo */ }
  finally { carregandoChat = false; }
}
setInterval(() => polling().catch(() => {}), 3000);

el("form-mensagem").addEventListener("submit", async event => {
  event.preventDefault();
  const teamId = selecionada;
  if (!teamId) return;
  const campo = el("mensagem-texto");
  const body = campo.value;
  if (!body.trim()) return;
  const [ok, data] = await api("send", { teamId, body });
  if (!ok) { message(data.error, true); return; }
  campo.value = "";
  if (selecionada !== teamId) return;
  aplicarLote([data.message]);
  el("chat-mensagens").scrollTop = el("chat-mensagens").scrollHeight;
});

// --- formulários ---------------------------------------------------------------------------------
el("form-convidar").addEventListener("submit", async event => {
  event.preventDefault();
  message("");
  const valor = el("convidar-para").value.trim();
  if (!valor) return;
  const corpo = valor.includes("@") ? { teamId: selecionada, email: valor } : { teamId: selecionada, name: valor };
  const [ok, data] = await api("invite", corpo);
  if (!ok) { message(data.error, true); return; }
  el("convidar-para").value = "";
  message(data.message);
  await carregar();
});

el("form-link").addEventListener("submit", async event => {
  event.preventDefault();
  message("");
  const [ok, data] = await api("invite-link", { teamId: selecionada, uses: Number(el("link-usos").value) });
  if (!ok) { message(data.error, true); return; }
  const pronto = el("link-pronto");
  pronto.hidden = false;
  pronto.textContent = "Link de convite (guarde agora, ele não aparece de novo): " + location.origin + data.url;
  await carregar();
});

el("botao-apagar-equipe").addEventListener("click", async () => {
  const team = teamById(selecionada);
  if (!team) return;
  if (!confirm(`Apagar a equipe ${team.name}? Membros, convites e mensagens serão removidos.`)) return;
  const [ok, data] = await api("delete", { teamId: team.id });
  if (!ok) { message(data.error, true); return; }
  selecionada = null;
  mensagens = [];
  message("Equipe apagada.");
  await carregar();
});

el("botao-sair-equipe").addEventListener("click", async () => {
  const [ok, data] = await api("leave", { teamId: selecionada });
  if (!ok) { message(data.error, true); return; }
  selecionada = null;
  mensagens = [];
  message("Você saiu da equipe.");
  await carregar();
});

el("botao-principal").addEventListener("click", () =>
  agir("primary", { teamId: selecionada }, "Equipe principal atualizada."));

el("form-criar").addEventListener("submit", async event => {
  event.preventDefault();
  message("");
  const [ok, data] = await api("create", {
    name: el("equipe-nome").value,
    tag: el("equipe-sigla").value,
    country: el("equipe-pais").value
  });
  if (!ok) { message(data.error, true); return; }
  el("equipe-nome").value = "";
  el("equipe-sigla").value = "";
  message(`Equipe ${data.team.name} criada. Você é a capitã.`);
  await carregar();
  trocarPara(data.team.id);
});

// --- carga ---------------------------------------------------------------------------------------
async function preencherPaises() {
  const response = await fetch("/api/profile/countries", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return;
  const select = el("equipe-pais");
  const options = data.countries
    .map(code => ({ code, name: countryNames.of(code) || code }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  select.replaceChildren(new Option("Sem país", ""));
  for (const { code, name } of options) select.add(new Option(`${flag(code)} ${name}`, code));
}

async function carregar() {
  const [ok, data] = await api("get");
  if (!ok) { message(data.error, true); return; }
  estado = data;
  if (selecionada && !teamById(selecionada)) {
    selecionada = null;
    mensagens = [];
    el("chat-mensagens").replaceChildren();
  }
  renderConvites();
  renderEquipes();
  renderDetalhe();
}

async function iniciar() {
  await preencherPaises();
  // Link de convite (equipe.html#convite=<token>): entra direto e limpa o fragmento.
  let recente = null;
  const convite = /#convite=([A-Za-z0-9_-]{43})/.exec(location.hash);
  if (convite) {
    history.replaceState(null, "", location.pathname);
    const [ok, data] = await api("join-link", { token: convite[1] });
    if (ok) { recente = data.teamId; message("Você entrou na equipe pelo link de convite."); }
    else message(data.error, true);
  }
  await carregar();
  const alvo = recente ?? (estado.teams.length ? estado.teams[0].id : null);
  if (alvo) trocarPara(alvo);
}
iniciar().catch(error => message(error.message || "Algo deu errado. Tente de novo.", true));
