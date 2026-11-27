# Servidor do Sail Simulator Pro

Decisões registradas no [ADR-0003](../adr/0003-hospedagem-postgresql.md) (hospedagem) e no [ADR-0004](../adr/0004-postgresql-banco-do-projeto.md) (backend nativo com PostgreSQL). Docker e contêineres são proibidos: todos os serviços rodam nativos.

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
| Backend nativo (API de salas + estáticos) | `server/main.mjs` na release, com `pg` instalado por `npm ci`; variáveis `DATABASE_URL` e `PORT` em `/opt/sail/{prod,test}.env` |
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
