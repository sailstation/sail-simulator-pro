/* Conta no jogo (ADR-0005/0006): mostra o botão "Sair" quando há sessão e, como segunda
   barreira (o servidor já redireciona), leva quem está com perfil incompleto para /perfil.html.
   Com o login desligado não há sessão: a API responde 401 e o botão fica oculto. */
"use strict";

(function () {
  const button = document.getElementById("account-logout");
  if (!button) return;
  button.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    location.assign("/login.html");
  });
  fetch("/api/profile/get", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then(async response => {
      if (!response.ok) return; // 401: login desligado (ou sessão expirada); nada a mostrar
      const data = await response.json();
      if (!data.complete) { location.assign("/perfil.html"); return; }
      button.hidden = false;
    })
    .catch(() => {});
})();
