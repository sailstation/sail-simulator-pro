# ADR-0004 — PostgreSQL como banco do projeto

Estado: proposto. Aguardando aceite do responsável pelo projeto na issue #31. O número é provisório e segue a ordem de merge (o ADR-0002 está no PR #28 e o ADR-0003 no PR #30).

Issue: sailstation/sail-simulator-pro#31.

Contexto: o backend de salas (`worker/index.js`) foi escrito para Cloudflare Workers com banco D1 (SQLite) e roda no servidor próprio por meio do adaptador `deploy/serve.mjs`, que emula o subconjunto da API do D1 sobre PostgreSQL (ADR-0003). A direção do produto pede um banco de nível corporativo, e a #10 já registra PostgreSQL como banco de referência. Manter o código em dialeto SQLite com um emulador de API adia o problema: cada recurso novo do backend teria de caber no subconjunto emulado, e a paridade D1/PostgreSQL continuaria dependendo de um esquema duplicado (`drizzle/` e `deploy/postgres/`).

Alternativas:
- Manter o Worker e o adaptador `serve.mjs` como caminho definitivo.
- Servidor de jogo autoritativo dedicado (a #10 continua aberta; esta decisão não a antecipa).
- Backend nativo em Node com PostgreSQL, reutilizando o contrato HTTP atual da API de salas.

Decisão:
- PostgreSQL é o banco do projeto. Todo código novo de backend fala SQL PostgreSQL diretamente, com parâmetros `$n`, por meio do driver `pg`.
- O backend de salas passa a viver em `server/`: `db.mjs` (pool e migrações), `rooms.mjs` (lógica portada de `worker/index.js`) e `main.mjs` (estáticos de `dist/`, API `/api/rooms/*`, `/__deploy`), configurado por `DATABASE_URL` e `PORT`.
- Migrações em `db/migrations/NNNN_*.sql`, aplicadas na partida e registradas na tabela `_migrations`. O primeiro arquivo mantém o nome `0000_regatta_rooms.sql`, já registrado no servidor. Timestamps em milissegundos como BIGINT, devolvidos como número (`pg.types.setTypeParser(20, Number)`).
- `worker/`, `drizzle/`, `scripts/build-site.mjs` e `.openai/hosting.json` são removidos. Isso encerra a hospedagem antiga no chatgpt.site. `ports/unity/Backend` permanece como cópia legada, sem evolução.
- O contrato HTTP da API de salas não muda: os clientes (`dist/multiplayer.js`, `ports/unity`) continuam funcionando, e `deploy/e2e.mjs` segue como validação ponta a ponta.
- Transição sem travar o GitOps: `deploy/start.sh` roda `current/server/main.mjs` quando existe e o `serve.mjs` legado quando não. Na produção, a infra do commit é aplicada antes da verificação de saúde do app.
- Docker e contêineres são proibidos no projeto (desenvolvimento, testes, CI e servidor); PostgreSQL e demais serviços rodam nativos. Definições da equipe (27/11/2026, aceite do responsável pendente).
- Testes da API rodam contra PostgreSQL real: cluster temporário nativo (`initdb`/`pg_ctl`, `scripts/pg-test.sh`) no CI e no desenvolvimento, e banco `sail_ci` (papel `sail-build`) no servidor. Cobertura mínima de 80% em `server/`.

Consequências:
- O código deixa de ser compatível com Cloudflare Workers; voltar exigiria reescrever a camada de dados.
- `deploy/serve.mjs` e `deploy/postgres/` permanecem apenas como caminho de rollback para releases antigas, até serem removidos por decisão futura. Migrações novas vão em `db/migrations/` e, enquanto o adaptador legado existir, devem ser espelhadas em `deploy/postgres/`.
- Dependência nova no repositório: `pg` (com lockfile), instalada no deploy por `npm ci --ignore-scripts`.
- Migrações continuam fora do rollback automático: expandir antes, contrair depois.
- A escolha do backend definitivo do jogo (servidor autoritativo, escala, regiões) continua aberta na #10, agora com PostgreSQL confirmado como banco.

Critérios de validação: `node --test` passa com PostgreSQL real e cobertura ≥ 80% em `server/`, localmente e no CI; `deploy/e2e.mjs` passa nos dois ambientes após o merge; a release nova sobe por `start.sh` sem intervenção manual e a release anterior continua subindo pelo `serve.mjs` legado; aceite do responsável na issue #31.
