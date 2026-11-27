# Servidor do Sail Simulator Pro

Decisão registrada no [ADR-0003](../adr/0003-hospedagem-postgresql.md).

| Ambiente | Endereço | O que publica |
| --- | --- | --- |
| Produção | https://sail-pro.sailstation.com | `main`, somente se `node --test scripts/*.test.mjs` e o build passarem |
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
| Adaptador Worker → Node/PostgreSQL | `/opt/sail/bin/serve.mjs` (fonte: `deploy/serve.mjs`) |
| Deploy contínuo | `/opt/sail/bin/deploy.sh`, `sail-deploy.timer` (a cada minuto) |
| Releases | `/opt/sail/releases/<commit>` (as 10 mais recentes), `/opt/sail/{prod,test}/current` |
| Estado do deploy | `/opt/sail/state/` (`prod.sha`, `prod.failed`, `test.sha`, `test.refs`) |
| Esquema do banco | `/opt/sail/schema` (fonte: `deploy/postgres/`), aplicado na partida do serviço |
| Serviços | `sail@prod`, `sail@test`, `caddy`, `postgresql` |

Usuários: `sail-build` roda testes e build sem rede e sem acesso aos dados; `sail-prod` e `sail-test` rodam cada ambiente e são donos do próprio banco.

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
- **Mudanças em `deploy/`:** não são aplicadas pelo deploy contínuo. Depois do merge, no servidor: `git -C /opt/sail/src pull && /opt/sail/src/deploy/install.sh` (ou a partir de qualquer clone).
- **Nova migração:** acrescente `drizzle/NNNN_*.sql` (D1) e o equivalente `deploy/postgres/NNNN_*.sql` no mesmo PR.

## Instalação do zero

Em uma VM Debian 13 com os nomes já roteados no Rudder, como root:

```sh
git clone https://github.com/sailstation/sail-simulator-pro.git /opt/sail/src
/opt/sail/src/deploy/install.sh
node /opt/sail/src/deploy/e2e.mjs https://sail-test.sailstation.com
```

## Segurança

- PRs de forks externos não são executados. Só os PRs com branch neste repositório vão para o ambiente de teste.
- Testes e build de qualquer commit rodam como `sail-build`: sem rede, sistema de arquivos somente leitura fora da release, 2 GB de memória e 5 minutos.
- O ambiente de teste é público e marcado `noindex`. Não use dados reais nele.
