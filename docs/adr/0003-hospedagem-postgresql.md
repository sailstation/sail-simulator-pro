# ADR-0003 — Hospedagem própria com PostgreSQL, deploy contínuo e ambiente de teste

Estado: proposto. Aguardando aceite do responsável pelo projeto na issue #29. O número é provisório e segue a ordem de merge (o ADR-0002 está no PR #28).

Issue: sailstation/sail-simulator-pro#29.

Contexto: o backend de salas (`worker/index.js`) foi escrito para Cloudflare Workers com banco D1 (SQLite). O projeto passa a rodar em servidor próprio da SailStation, com dois ambientes: produção, que só recebe código integrado e testado, e teste, onde qualquer PR pode ser visto rodando mesmo com testes falhando. A equipe pediu um banco de nível corporativo em vez de SQLite.

Alternativas:
- Manter Cloudflare Workers e D1.
- Servidor próprio com SQLite em arquivo (rodou só durante a instalação de 27/11/2026, sem dados).
- Servidor próprio com PostgreSQL, mantendo o código do Worker inalterado por meio de um adaptador.
- Reescrever o backend para um servidor de jogo autoritativo (fica para a #10).

Decisão:
- PostgreSQL 17 do Debian, com bancos separados `sail_prod` e `sail_test`, cada um com papel próprio e autenticação peer por socket Unix (sem senha armazenada).
- `deploy/serve.mjs` hospeda o build do Worker (`dist/server/index.js`) em Node 24. Ele implementa o subconjunto da API do D1 usado pelo Worker (`prepare`, `bind`, `first`, `all`, `run`, `batch` transacional), traduz `?` para `$n` e devolve BIGINT como número.
- O esquema PostgreSQL fica em `deploy/postgres/`, equivalente a `drizzle/`, com timestamps em milissegundos como BIGINT. Toda mudança em `drizzle/` exige a migração correspondente em `deploy/postgres/` no mesmo PR.
- Caddy termina o TLS com certificados Let's Encrypt automáticos. O HAProxy da borda, gerenciado pelo Rudder, encaminha o TLS em passthrough por SNI e o HTTP para validação ACME.
- `sail-deploy.timer` verifica o GitHub a cada minuto:
  - Produção segue a `main` e só publica se os testes e o build passarem no servidor. Senão, mantém a versão anterior.
  - Teste publica o último push em PR de branch deste repositório, mesmo com testes falhando. PRs de forks externos não são executados no servidor.
- Infraestrutura como código (GitOps): mudanças em `deploy/` que chegam à `main` testada são aplicadas sozinhas por `deploy/infra-apply.sh`, que valida, faz backup, instala, verifica a saúde e reverte automaticamente em caso de falha. A produção também volta à release anterior se não ficar saudável depois de publicar. PRs nunca aplicam infraestrutura.
- Código do repositório é testado e construído como usuário sem privilégios, sem rede e com sistema de arquivos somente leitura. Produção e teste rodam com usuários e bancos diferentes.
- Docker e contêineres são proibidos no projeto (desenvolvimento, testes, CI e servidor); PostgreSQL e demais serviços rodam nativos. Definição da equipe (27/11/2026, aceite do responsável pendente).

Consequências:
- O código do jogo continua compatível com Cloudflare. A paridade entre D1 e PostgreSQL depende do adaptador e do esquema duplicado.
- O teste de API em SQLite (`ports/unity/Backend/rooms.test.mjs`) não cobre PostgreSQL. `deploy/e2e.mjs` cobre o fluxo real nos ambientes.
- Migrações de banco não são revertidas pelo rollback automático: devem ser compatíveis com a versão anterior do código.
- Rotas no Rudder/HAProxy, DNS e a VM continuam manuais.
- A escolha do backend definitivo do jogo (servidor autoritativo, escala, regiões) continua aberta na #10. PostgreSQL passa a ser o banco de referência para ela.

Critérios de validação: os dois endereços respondem por HTTPS com certificado válido em IPv4 e IPv6; `/__deploy` mostra o commit publicado; `deploy/e2e.mjs` passa nos dois ambientes; um merge na `main` aparece em produção em até 2 minutos; um push em PR aparece no teste em até 2 minutos; mudança inválida em `deploy/` é recusada ou revertida sem intervenção; aceite do responsável na issue.
