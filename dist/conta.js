/* Conta no jogo (ADR-0005/0006/0007): mostra o avatar (foto ou emoji), o botão "Equipe" e o
   botão "Sair" quando há sessão e, como segunda barreira (o servidor já redireciona), leva
   quem está com perfil incompleto para /perfil.html. Com o login desligado não há sessão: a
   API responde 401 e nada disso aparece. */
"use strict";

(function () {
  const button = document.getElementById("account-logout");
  if (!button) return;
  button.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    location.assign("/login.html");
  });
  const teamButton = document.getElementById("account-team");
  if (teamButton) {
    teamButton.addEventListener("click", () => location.assign("/equipe.html"));
  }
  fetch("/api/profile/get", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then(async response => {
      if (!response.ok) return; // 401: login desligado (ou sessão expirada); nada a mostrar
      const data = await response.json();
      if (!data.complete) { location.assign("/perfil.html"); return; }
      const avatar = document.getElementById("account-avatar");
      if (avatar && data.avatar) {
        if (data.avatar.type === "photo") {
          const img = document.createElement("img");
          img.src = "/api/profile/photo?t=" + data.avatar.photoAt;
          img.alt = "";
          avatar.append(img);
        } else {
          avatar.textContent = data.avatar.emoji;
        }
        avatar.hidden = false;
      }
      if (teamButton) teamButton.hidden = false;
      button.hidden = false;
    })
    .catch(() => {});
})();
