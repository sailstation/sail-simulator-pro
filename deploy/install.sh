#!/bin/bash
# Instala ou atualiza a hospedagem do Sail Simulator Pro em Debian 13.
# Uso, como root, a partir de um clone do repositório: deploy/install.sh
# Idempotente: pode ser executado de novo após mudanças em deploy/.
set -euo pipefail
cd "$(dirname "$0")"
NODE_MAJOR=24
export DEBIAN_FRONTEND=noninteractive

PACKAGES="git caddy curl xz-utils ca-certificates jq postgresql"
if ! dpkg -s $PACKAGES >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq $PACKAGES >/dev/null
fi
systemctl enable -q --now postgresql

if ! /opt/node/bin/node --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  V=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r "[.[]|select(.version|startswith(\"v$NODE_MAJOR.\"))][0].version")
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  curl -fsSL -o "$T/node.tar.xz" "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " node-$V-linux-x64.tar.xz$" | awk '{print $1"  '"$T"'/node.tar.xz"}' | sha256sum -c -
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$T/node.tar.xz" -C /opt/node --strip-components=1
fi
export PATH=/opt/node/bin:$PATH

for u in sail-build sail-prod sail-test; do id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$u"; done
mkdir -p /opt/sail/{bin,state,releases,prod,test,schema,infra}

for e in prod test; do
  sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname='sail-$e'" | grep -q 1 || sudo -u postgres psql -qc "CREATE ROLE \"sail-$e\" LOGIN"
  sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname='sail_$e'" | grep -q 1 || sudo -u postgres createdb -O "sail-$e" "sail_$e"
  sudo -u postgres psql -qc "REVOKE ALL ON DATABASE sail_$e FROM PUBLIC"
done
# Banco dos testes do backend nativo no deploy (deploy.sh); o papel é o usuário que roda os testes (auth peer).
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname='sail-build'" | grep -q 1 || sudo -u postgres psql -qc "CREATE ROLE \"sail-build\" LOGIN"
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname='sail_ci'" | grep -q 1 || sudo -u postgres createdb -O sail-build sail_ci
sudo -u postgres psql -qc "REVOKE ALL ON DATABASE sail_ci FROM PUBLIC"

install -m 644 serve.mjs package.json /opt/sail/bin/
# Scripts em execução são trocados por renomeação atômica, nunca sobrescritos no lugar.
for f in deploy.sh infra-apply.sh start.sh release-format.sh; do install -m 755 "$f" "/opt/sail/bin/.$f.new" && mv -f "/opt/sail/bin/.$f.new" "/opt/sail/bin/$f"; done
install -m 644 postgres/*.sql /opt/sail/schema/
install -m 644 env/prod.env env/test.env /opt/sail/
# Segredos do login (SAIL_POW_SECRET, SMTP_*): a unit lê /opt/sail/<ambiente>.secrets.env
# (EnvironmentFile opcional). Cria vazio se não existir; o conteúdo é preenchido à mão no
# servidor e nunca é sobrescrito pelo GitOps. Sem SMTP_HOST nele, o login fica desligado.
for e in prod test; do
  [ -f "/opt/sail/$e.secrets.env" ] || install -m 600 -o root -g root /dev/null "/opt/sail/$e.secrets.env"
done
install -m 644 systemd/sail@.service systemd/sail-deploy.service systemd/sail-deploy.timer /etc/systemd/system/
install -m 644 caddy/Caddyfile /etc/caddy/Caddyfile
(cd /opt/sail/bin && npm install --silent --no-fund --no-audit --omit=dev)
chmod -R a+rX /opt/sail/bin /opt/sail/schema

systemctl daemon-reload
systemctl enable -q sail@prod sail@test
# Dentro do GitOps (infra-apply.sh) o deploy já está em andamento; na instalação manual, publica agora.
[ "${SAIL_SKIP_DEPLOY:-0}" = 1 ] || /opt/sail/bin/deploy.sh
systemctl restart sail@prod sail@test
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { echo "Caddyfile inválido" >&2; exit 1; }
systemctl reload-or-restart caddy
systemctl enable -q --now sail-deploy.timer
echo "Instalação concluída."
