/* Tela "Minha carreira" (ADR-0008): licença atual, escada com o que falta, classes liberadas,
   provas e extrato do livro-razão. Consulta /api/career/get; todo texto via textContent. */
"use strict";

const el = id => document.getElementById(id);

function message(text, isError = false) {
  const box = el("mensagem");
  box.hidden = !text;
  box.classList.toggle("erro", isError);
  box.textContent = text || "";
}

const data = ms => new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });

function selo(texto, classe) {
  const span = document.createElement("span");
  span.className = "selo" + (classe ? " " + classe : "");
  span.textContent = texto;
  return span;
}

function renderResumo(estado) {
  el("licenca-atual").textContent = estado.license.name;
  el("pontos-atuais").textContent = String(estado.points);
}

function renderLicencas(estado) {
  el("lista-licencas").replaceChildren(...estado.licenses.map(licenca => {
    const item = document.createElement("li");
    if (licenca.id === estado.license.id) item.className = "atual";
    const titulo = document.createElement("span");
    titulo.textContent = licenca.name;
    item.append(titulo);
    if (licenca.granted) {
      item.append(selo(licenca.since ? `conquistada em ${data(licenca.since)}` : "ponto de partida", "ok"));
    }
    if (licenca.minPoints > 0 || licenca.achievements.length) {
      const lista = document.createElement("ul");
      lista.className = "requisitos";
      if (licenca.minPoints > 0) {
        const req = document.createElement("li");
        const faltam = Math.max(0, licenca.minPoints - estado.points);
        req.textContent = `${licenca.minPoints} pontos` + (licenca.granted || faltam === 0 ? "" : ` (faltam ${faltam})`);
        if (licenca.granted || faltam === 0) req.className = "feita";
        lista.append(req);
      }
      for (const prova of licenca.achievements) {
        const req = document.createElement("li");
        req.textContent = prova.name;
        if (prova.done) req.className = "feita";
        lista.append(req);
      }
      item.append(lista);
    }
    return item;
  }));
}

function renderClasses(estado) {
  el("lista-classes").replaceChildren(...estado.classes.map(cls => {
    const item = document.createElement("li");
    const nome = document.createElement("span");
    nome.textContent = cls.name;
    const niveis = document.createElement("span");
    niveis.className = "niveis";
    niveis.textContent = cls.tiers.map(tier => tier === "inicial" ? "inicial" : "avançada").join(" · ");
    item.append(nome, niveis);
    if (cls.unlocked) {
      item.append(selo("liberada", "ok"));
    } else {
      const exigida = estado.licenses.find(l => l.id === cls.requires);
      item.append(selo(`exige licença ${exigida ? exigida.name : cls.requires}`, "bloq"));
    }
    return item;
  }));
}

function renderProvas(estado) {
  el("sem-provas").hidden = estado.achievements.length > 0;
  el("lista-provas").replaceChildren(...estado.achievements.map(prova => {
    const item = document.createElement("li");
    item.textContent = prova.name;
    const quando = document.createElement("span");
    quando.className = "quando";
    quando.textContent = data(prova.created);
    item.append(quando);
    return item;
  }));
}

function renderExtrato(estado) {
  el("sem-extrato").hidden = estado.history.length > 0;
  el("lista-extrato").replaceChildren(...estado.history.map(lancamento => {
    const item = document.createElement("li");
    const pontos = document.createElement("span");
    pontos.className = "pontos-lancamento" + (lancamento.points < 0 ? " neg" : "");
    pontos.textContent = (lancamento.points > 0 ? "+" : "") + lancamento.points;
    const motivo = document.createElement("span");
    motivo.textContent = lancamento.reason;
    const quando = document.createElement("span");
    quando.className = "quando";
    quando.textContent = data(lancamento.created);
    item.append(pontos, motivo, quando);
    return item;
  }));
}

async function carregar() {
  let response;
  try {
    response = await fetch("/api/career/get", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch {
    message("Sem conexão com o servidor. Tente de novo.", true);
    return;
  }
  if (response.status === 401) { location.assign("/login.html"); return; }
  if (response.status === 403) { location.assign("/perfil.html"); return; }
  if (!response.ok) { message("Não foi possível carregar a carreira. Tente de novo.", true); return; }
  const estado = await response.json();
  renderResumo(estado);
  renderLicencas(estado);
  renderClasses(estado);
  renderProvas(estado);
  renderExtrato(estado);
}

carregar();
