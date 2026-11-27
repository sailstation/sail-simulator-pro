/* Tela de entrada (ADR-0005): login, cadastro, confirmação de e-mail e recuperação de senha.
   A verificação anti-robô é uma prova de trabalho resolvida aqui com Web Crypto (SHA-256). */
"use strict";

const el = id => document.getElementById(id);
const views = ["entrar", "cadastro", "recuperar", "redefinir"];
let resetToken = "";

function show(view) {
  for (const name of views) el("form-" + name).hidden = name !== view;
  el("linha-reenviar").hidden = true;
}
function message(text, isError = false) {
  const box = el("mensagem");
  box.hidden = !text;
  box.classList.toggle("erro", isError);
  box.textContent = text || "";
}
async function api(action, body) {
  try {
    const response = await fetch("/api/auth/" + action, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    return [response.ok, data];
  } catch {
    return [false, { error: "Sem conexão com o servidor. Tente de novo." }];
  }
}

// Prova de trabalho: procura nonce com sha256("desafio.nonce") tendo `bits` zeros à esquerda.
const zeroBits = digest => {
  let bits = 0;
  for (const byte of new Uint8Array(digest)) {
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
};
async function solvePow() {
  const [okChallenge, challenge] = await api("challenge", {});
  if (!okChallenge) throw new Error(challenge.error || "Não foi possível iniciar a verificação.");
  const bits = Number(challenge.challenge.split(".")[2]);
  const encoder = new TextEncoder();
  el("trabalho").hidden = false;
  try {
    for (let nonce = 0; ; nonce++) {
      const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${challenge.challenge}.${nonce}`));
      if (zeroBits(digest) >= bits) return { challenge: challenge.challenge, signature: challenge.signature, nonce };
      if (nonce % 512 === 511) {
        el("trabalho-conta").textContent = String(nonce + 1);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  } finally {
    el("trabalho").hidden = true;
  }
}

async function submit(form, run) {
  message("");
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try { await run(); }
  catch (error) { message(error.message || "Algo deu errado. Tente de novo.", true); }
  finally { button.disabled = false; }
}
const passwords = form => {
  const [first, second] = [form.password.value, form.password2.value];
  if (first.length < 10) throw new Error("A senha precisa de pelo menos 10 caracteres.");
  if (first !== second) throw new Error("As senhas não são iguais.");
  return first;
};

el("form-entrar").addEventListener("submit", event => {
  event.preventDefault();
  submit(event.target, async () => {
    const form = event.target;
    const [ok, data] = await api("login", { email: form.email.value, password: form.password.value });
    if (!ok) {
      el("linha-reenviar").hidden = !/Confirme seu e-mail/.test(data.error || "");
      throw new Error(data.error);
    }
    location.assign("/");
  });
});

el("form-cadastro").addEventListener("submit", event => {
  event.preventDefault();
  submit(event.target, async () => {
    const form = event.target;
    const password = passwords(form);
    const [ok, data] = await api("signup", { email: form.email.value, password, pow: await solvePow() });
    if (!ok) throw new Error(data.error);
    message(data.message);
    show("entrar");
  });
});

el("form-recuperar").addEventListener("submit", event => {
  event.preventDefault();
  submit(event.target, async () => {
    const [ok, data] = await api("recover", { email: event.target.email.value, pow: await solvePow() });
    if (!ok) throw new Error(data.error);
    message(data.message);
    show("entrar");
  });
});

el("form-redefinir").addEventListener("submit", event => {
  event.preventDefault();
  submit(event.target, async () => {
    const password = passwords(event.target);
    const [ok, data] = await api("reset", { token: resetToken, password });
    if (!ok) throw new Error(data.error);
    message(data.message);
    resetToken = "";
    history.replaceState(null, "", "#entrar");
    show("entrar");
  });
});

el("botao-reenviar").addEventListener("click", event => {
  submit(event.target.closest("form"), async () => {
    const [ok, data] = await api("resend", { email: el("entrar-email").value, pow: await solvePow() });
    if (!ok) throw new Error(data.error);
    message(data.message);
    el("linha-reenviar").hidden = true;
  });
});

for (const link of document.querySelectorAll("[data-view]")) {
  link.addEventListener("click", () => { message(""); show(link.dataset.view); });
}

// Links dos e-mails: /login.html#confirmar=TOKEN e /login.html#redefinir=TOKEN.
async function fromHash() {
  const [, name, token] = /^#(confirmar|redefinir)=([A-Za-z0-9_-]+)$/.exec(location.hash) ?? [];
  if (name === "confirmar") {
    const [ok, data] = await api("confirm", { token });
    message(data.message || data.error, !ok);
    history.replaceState(null, "", "#entrar");
    show("entrar");
  } else if (name === "redefinir") {
    resetToken = token;
    show("redefinir");
  } else if (views.includes(location.hash.slice(1))) {
    show(location.hash.slice(1));
  } else {
    show("entrar");
  }
}
fromHash();
