/* Bandeiras dos países (ADR-0006, ajuste de 28/11/2026): imagens Twemoji (CC-BY 4.0) servidas
   pelo próprio site em /flags/, porque o emoji Unicode de bandeira não renderiza no
   Chrome/Windows. Se o arquivo faltar, cai no código de duas letras como texto. */
"use strict";

// Elemento de bandeira para um código ISO 3166-1 alfa-2 (ex.: "BR").
window.bandeira = code => {
  const img = document.createElement("img");
  img.className = "bandeira";
  img.alt = "";
  img.loading = "lazy";
  img.src = "/flags/" + String(code).toLowerCase() + ".png";
  img.addEventListener("error", () => {
    const span = document.createElement("span");
    span.className = "bandeira bandeira-texto";
    span.textContent = code;
    img.replaceWith(span);
  });
  return img;
};

// Rótulo textual para <option> (que não aceita imagem): "BR · Brasil".
window.bandeiraRotulo = (code, name) => `${code} · ${name}`;
