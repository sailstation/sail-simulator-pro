# Servidor do Sail Simulator Pro

Decisões registradas no [ADR-0003](../adr/0003-hospedagem-postgresql.md) (hospedagem), no [ADR-0004](../adr/0004-postgresql-banco-do-projeto.md) (backend nativo com PostgreSQL), no [ADR-0005](../adr/0005-contas-login-confirmacao-email.md) (contas e login obrigatório) e no [ADR-0006](../adr/0006-perfil-velejador.md) (perfil do velejador). Docker e contêineres são proibidos: todos os serviços rodam nativos.

| Ambiente | Endereço | O que publica |
| --- | --- | --- |
| Produção | https://sail-pro.sailstation.com | `main`, somente se os testes e o build do formato da release passarem (ver abaixo) |
| Teste | https://sail-test.sailstation.com | Último push em qualquer PR deste repositório, mesmo com testes falhando. Sem PR, a `main` |

`GET /__deploy` em cada endereço mostra o ambiente, o commit, a origem (`main` ou `PR #N`), o resultado dos testes e do build, e a data da publicação.

## Caminho de rede

```
Internet ──80/443──▶ HAProxy da borda (Rudder, SNI) ──▶ VM sail-pro 2804:710:d0:59::c:1
  sail-pro:  HTTP → :8000   TLS (passthrough) → :443   ─▶ Caddy ─▶ 127.0.0.1:9000 sail@prod ─▶ PostgreSQL sail_prod
  sail-test: HTTP → :8001   TLS (passthrough) → :8443  ─▶ Caddy ─▶ 127.0.0.1:9001 sail@test ─▶ PostgreSQL sail_test
```

As portas HTTP redirecionam para HTTPS e atendem a validação ACME. O Caddy renova os certificados sozinho.

## Componentes na VM (Debian 13)

| Item | Onde |
| --- | --- |
| Node 24 | `/opt/node` |
| Lançador do app | `/opt/sail/bin/start.sh` (fonte: `deploy/start.sh`): roda `current/server/main.mjs` quando a release tem backend nativo; senão, o adaptador legado |
| Backend nativo (API de contas e salas + estáticos) | `server/main.mjs` na release, com `pg` instalado por `npm ci`; variáveis em `/opt/sail/{prod,test}.env` e segredos em `/opt/sail/{prod,test}.secrets.env` (ver "Login e e-mail") |
| Adaptador legado Worker → Node/PostgreSQL | `/opt/sail/bin/serve.mjs` (fonte: `deploy/serve.mjs`), só para releases antigas (rollback) |
| Deploy contínuo | `/opt/sail/bin/deploy.sh`, `sail-deploy.timer` (a cada minuto) |
| Aplicação de infraestrutura | `/opt/sail/bin/infra-apply.sh`, backups em `/opt/sail/infra/` |
| Releases | `/opt/sail/releases/<commit>` (as 10 mais recentes), `/opt/sail/{prod,test}/current` |
| Estado do deploy | `/opt/sail/state/` (`prod.sha`, `prod.failed`, `test.sha`, `test.refs`) |
| Migrações do banco | `db/migrations/` na release, aplicadas na partida do serviço e registradas em `_migrations`; `/opt/sail/schema` (fonte: `deploy/postgres/`) só para o adaptador legado |
| Serviços | `sail@prod`, `sail@test`, `caddy`, `postgresql` |

Usuários: `sail-build` roda testes e build sem rede e sem acesso aos dados (a etapa `npm ci` de releases nativas roda antes, com rede, em sandbox separado) e é dono do banco `sail_ci`, usado pelos testes do backend nativo no deploy; `sail-prod` e `sail-test` rodam cada ambiente e são donos do próprio banco.

## Formatos de release (transição do ADR-0004)

O `deploy.sh` reconhece o formato de cada release por `release-format.sh` e ajusta testes, build e critério de publicação:

| Formato | Reconhecida por | Testes | Build | Pronta quando |
| --- | --- | --- | --- | --- |
| Legada | demais árvores | `node --test scripts/*.test.mjs` | `node scripts/build-site.mjs` | existe `dist/server/index.js` |
| Nativa | `server/main.mjs` + `package-lock.json` | `scripts/*.test.mjs` e `server/*.test.mjs` (contra o banco `sail_ci`) | `npm ci --ignore-scripts`; `node_modules/pg` presente | existe `server/main.mjs` |

A transição acontece em dois merges, sem nenhum passo manual no servidor:

1. **PR #30 (transição):** a árvore ainda é legada, então o `deploy.sh` antigo publica a `main` normalmente (testes de `scripts/` e `build-site.mjs` passam) e aplica o `deploy/` novo pelo GitOps: `release-format.sh`, `start.sh` como `ExecStart` da unit `sail@`, `PORT`/`DATABASE_URL` nos envs, banco `sail_ci` e papel `sail-build`. Como a release ativa é legada, o `start.sh` segue subindo o `serve.mjs`.
2. **PR #31 (backend nativo):** o `deploy.sh` novo detecta a release nativa, roda `npm ci` e os testes de `server/` contra o `sail_ci`, publica e o `start.sh` sobe o `server/main.mjs`. Releases antigas (merge do #28/#30, PRs legados no ambiente de teste) continuam pelo caminho legado, então nenhuma delas trava o deploy.

## Login e e-mail (ADR-0005)

Com o login ligado, o site e a API de salas exigem sessão: sem cookie válido, os estáticos redirecionam para `/login.html` e `/api/rooms/*` responde 401. Só ficam públicos `/login.html`, `login.css`, `login.js`, a foto de fundo, `/__deploy` e `/api/auth/*`.

O login é controlado por `SAIL_LOGIN_REQUIRED`: o padrão é **ligado quando `SMTP_HOST` está definido e desligado quando não está**; `SAIL_ENV=test` liga sempre (com os e-mails no log quando não há SMTP) e `SAIL_LOGIN_REQUIRED=1/0` força o valor nos demais casos. Com o login desligado, o site e a API de salas funcionam como antes do ADR-0005 e a tela de entrada não bloqueia nada.

Variáveis do backend (além de `PORT` e `DATABASE_URL`):

| Variável | Onde | Para quê |
| --- | --- | --- |
| `SAIL_ENV` | unit `sail@` (automática: `prod`/`test`) | `test` habilita `/api/auth/test-confirm` (usada pelo `deploy/e2e.mjs`) e liga o login sempre |
| `SAIL_LOGIN_REQUIRED` | opcional, em `secrets.env` | `1`/`0` força o login ligado/desligado; sem ela, vale o padrão do `SMTP_HOST` |
| `SAIL_BASE_URL` | `/opt/sail/{prod,test}.env` | domínio dos links de confirmação e redefinição enviados por e-mail |
| `SAIL_POW_SECRET` | `/opt/sail/{prod,test}.secrets.env` | segredo HMAC dos desafios do captcha de prova de trabalho; sem ele o processo gera um aleatório na partida (desafios em aberto invalidam no reinício; avisa no log) |
| `SAIL_POW_BITS` | opcional, padrão 16 | dificuldade do captcha (bits zero exigidos no hash) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | `/opt/sail/{prod,test}.secrets.env` | envio dos e-mails de confirmação e recuperação; porta 587 usa STARTTLS, 465 TLS implícito, `SMTP_TLS=off` desliga (relay local). Sem `SMTP_HOST`, os e-mails vão para o log do serviço (`journalctl -u sail@…`) em vez de serem enviados |

Os `.env` versionados são reinstalados pelo GitOps a cada mudança em `deploy/`; por isso os segredos ficam em `/opt/sail/{prod,test}.secrets.env` (a unit `sail@` lê os dois arquivos, com o de segredos opcional via `EnvironmentFile=-`). O `install.sh` cria o arquivo vazio com permissão 0600 se ele não existir e **nunca o sobrescreve**; o conteúdo é preenchido à mão no servidor e nunca vai para o repositório:

```sh
editor /opt/sail/prod.secrets.env
# SAIL_POW_SECRET=…  SMTP_HOST=…  SMTP_PORT=587  SMTP_USER=…  SMTP_PASS=…  SMTP_FROM="Sail <no-reply@…>"
systemctl restart sail@prod   # login liga sozinho com SMTP_HOST definido
```

O `deploy/e2e.mjs` cobre o fluxo completo (cadastro com prova de trabalho, confirmação pela rota de teste, login, perfil obrigatório, salas e logout) e só funciona contra um servidor com `SAIL_ENV=test`.

## Perfil do velejador (ADR-0006)

Com o login ligado, quem entra sem perfil completo (foto, nome de exibição, país e clube) é redirecionado para `/perfil.html` e a API de salas responde 403 até completar. A API fica em `/api/profile/*` e sempre exige sessão — com o login desligado ela responde 401 e o site funciona como antes, sem exigir perfil.

- **Fotos** ficam no PostgreSQL (`bytea`, até 2 MB, JPEG/PNG/WebP conferidos pela estrutura completa do arquivo) e saem só com sessão, com `Content-Type` gravado e `nosniff`. Metadados (EXIF/GPS, XMP, IPTC, comentários) são removidos no servidor antes de gravar, em JavaScript puro; foto malformada recebe 400. Não há diretório de uploads nem variável nova.
- **Clubes**: a tabela `clubs` nasce com uma semente de clubes brasileiros marcados "a verificar" (`verified=false`). Sugestões de jogadores entram como `pending` e só aparecem para o autor.
- **Moderação (manual, por enquanto)**:

```sh
sudo -u postgres psql sail_prod -c "SELECT id, name, country, city, created_by FROM clubs WHERE status='pending'"
sudo -u postgres psql sail_prod -c "UPDATE clubs SET status='approved', verified=true WHERE id='<id>'"
sudo -u postgres psql sail_prod -c "UPDATE clubs SET status='rejected' WHERE id='<id>'"
```

- **Importação do OpenStreetMap (offline, nunca no deploy)**: gere o extrato no Overpass (`[out:json];(nwr["leisure"="sailing_club"];nwr["club"="sailing"];);out tags;`), rode `node scripts/import-clubs-osm.mjs extrato.json --country BR > clubes.sql`, revise o SQL (a atribuição ODbL vai no cabeçalho) e aplique com `psql`. A compatibilidade da ODbL precisa estar confirmada (issue #33) antes da primeira importação real.

### Transição do login (por que nada trava)

O deploy ativa a release nova **antes** de aplicar a infra do commit, e o `app_healthy` do `deploy.sh` que estava na main exige **404 exato** de `/api/rooms/sync` — uma release respondendo 401 seria revertida e a infra nunca seria aplicada. A sequência segura, sem nenhum passo manual:

1. **Merge deste PR:** o `deploy.sh` antigo publica a release nova (formato nativo, testes ok) e reinicia o serviço com a unit e o `prod.env` atuais do servidor — sem `secrets.env`, sem `SMTP_HOST`, sem `SAIL_POW_SECRET`. O login fica **desligado**, então a sonda antiga passa: 200 em `/` e 404 em `/api/rooms/sync`.
2. **Infra do commit aplicada pelo GitOps:** a unit nova (com o `EnvironmentFile=-…secrets.env` opcional) é validada e instalada, o `install.sh` cria os `secrets.env` vazios (0600) e o `healthy` do `infra-apply.sh` novo — que aceita 401 além de 404 — confirma a saúde com o login ainda desligado.
3. **Quando o SMTP for configurado** no `prod.secrets.env` e o serviço reiniciar, o login liga sozinho. A partir daí `/api/rooms/sync` responde 401 sem sessão, que o `deploy.sh` e o `infra-apply.sh` novos aceitam — deploys e mudanças de infra seguintes seguem normais.

O mesmo cenário está coberto em `scripts/pg-test.sh` (sonda do deploy antigo contra o processo real sem SMTP).

## Operação

```sh
systemctl status sail@prod sail@test caddy postgresql
journalctl -u sail-deploy -f            # publicações
journalctl -u sail@prod -f              # aplicação
cat /opt/sail/releases/<commit>/tests.log
systemctl start sail-deploy             # forçar verificação agora
sudo -u postgres psql sail_prod         # banco
```

- **Produção recusou um commit:** o commit fica em `/opt/sail/state/prod.failed` e a versão anterior continua no ar. Corrija com um novo merge na `main`.
- **Voltar a produção para um commit anterior:** `ln -sfn /opt/sail/releases/<commit> /opt/sail/prod/current && systemctl restart sail@prod`. O próximo merge na `main` publica normalmente.
- **Produção não ficou saudável após publicar:** o deploy volta sozinho para a release anterior e grava o commit em `prod.failed`.
- **Nova migração:** acrescente `db/migrations/NNNN_*.sql` (aplicada na partida do backend). Enquanto o adaptador legado existir, espelhe em `deploy/postgres/NNNN_*.sql` no mesmo PR.

## Infraestrutura como código (GitOps)

Mudanças em `deploy/` se aplicam sozinhas quando chegam à `main` e a produção daquele commit foi publicada com testes ok. Nenhum PR aplica infraestrutura: só a `main` roda como root.

```
merge na main ─▶ testes e build do formato da release ok ─▶ produção publicada e saudável
              ─▶ deploy/ mudou? ─▶ infra-apply.sh do próprio commit
                    1. extrai deploy/ direto do Git
                    2. valida: sintaxe dos scripts (inclusive start.sh e release-format.sh), serve.mjs, Caddyfile, units systemd
                    3. backup em /opt/sail/infra/backup-*.tar (mantém 5)
                    4. install.sh (sem disparar outro deploy)
                    5. saúde por até 60 s: serviços ativos, produção responde e alcança o banco, TLS dos dois nomes
                    6. ok → grava infra.tree │ falha → restaura o backup, reinicia e grava infra.failed
```

- Estado: `/opt/sail/state/infra.tree` (aplicada) e `infra.failed` (recusada; não é tentada de novo até um novo commit mudar `deploy/`).
- Log: `journalctl -u sail-deploy | grep infra`.
- Migrações de banco não são revertidas pelo rollback. Escreva migrações compatíveis com a versão anterior (expandir antes, contrair depois).
- Fora do escopo do GitOps: rotas no Rudder/HAProxy, DNS e criação da VM.

Validado em 27/11/2026 com commits de teste locais no servidor: Caddyfile inválido foi recusado antes de instalar; um `serve.mjs` que deixava a produção fora do ar foi instalado, detectado pela verificação de saúde e revertido sozinho (cerca de 1 min de indisponibilidade).

## Instalação do zero

Em uma VM Debian 13 com os nomes já roteados no Rudder, como root:

```sh
git clone https://github.com/sailstation/sail-simulator-pro.git /opt/sail/src
/opt/sail/src/deploy/install.sh
node /opt/sail/src/deploy/e2e.mjs https://sail-test.sailstation.com
```

## Segurança

- PRs de forks externos não são executados. Só os PRs com branch neste repositório vão para o ambiente de teste.
- Testes e build de qualquer commit rodam como `sail-build`: sem rede, sistema de arquivos somente leitura fora da release, 2 GB de memória e 5 minutos. O acesso ao PostgreSQL se limita ao banco `sail_ci` (dados descartáveis); produção e teste ficam fora do alcance.
- A etapa `npm ci --ignore-scripts` de releases nativas roda com rede, em sandbox separado, também como `sail-build`.
- O ambiente de teste é público e marcado `noindex`. Não use dados reais nele.
