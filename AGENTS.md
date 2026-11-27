# Instruções para agentes de IA e colaboradores

Vale para Codex, Claude e qualquer outro agente ou pessoa que trabalhe neste projeto. Leia antes de alterar qualquer arquivo.

## Antes de começar (obrigatório)
1. Leia este arquivo inteiro e o [README](README.md).
2. Leia o [índice de ADRs](docs/adr/README.md) e todos os ADRs aceitos.
3. Leia a issue que você vai resolver, com os comentários. Leia também as issues de ADR propostas que ela cita (label `adr`, épico #19).
4. Se a mudança toca o servidor ou `deploy/`, leia `docs/infra/servidor.md`.
5. Se algo não estiver decidido em um ADR aceito, não decida sozinho: pergunte ou proponha um ADR.
6. Não use Docker nem contêineres.

## Repositório
- O repositório canônico é **sailstation/sail-simulator-pro** ([ADR-0002](docs/adr/0002-repositorio-canonico.md)). Abra issues, branches e PRs somente nele. Com `gh`, use `-R sailstation/sail-simulator-pro`.
- gvestphal-glitch/sail-simulator-pro é o `upstream` histórico. Não abra nada lá.

## Fluxo obrigatório ([ADR-0001](docs/adr/0001-fluxo.md))
1. Trabalhe só a partir de uma issue com objetivo e critérios de aceite.
2. Antes do código, registre o ADR em `docs/adr/NNNN-titulo.md`: issue, contexto, alternativas, decisão, consequências e critérios de validação. O número é o próximo livre no momento do merge.
3. O aceite do responsável pelo projeto é registrado na issue. Sem aceite, a decisão continua proposta.
4. Uma branch por issue e um PR por feature, com ADR, código, testes e `Closes #N`.
5. Um PR de feature em andamento por vez. Consulte os PRs abertos antes de começar.
6. Integração na `main` só depois da revisão. Publicar o jogo é etapa separada.

## Regras de trabalho
- Fique no escopo da issue. Não reorganize, renomeie nem "melhore" arquivos fora dela.
- Não altere um ADR aceito: uma mudança de decisão exige um novo ADR que substitua o anterior.
- Não adicione dependências, serviços ou pacotes sem ADR.
- Não invente dados técnicos (dimensões, deslocamento, polares, regras, licenças) nem resultados de testes. Cite a fonte e marque estimativas como estimativas, nunca como dados oficiais.
- Diga explicitamente o que não foi validado, por exemplo desempenho em aparelho real, build iOS ou Android, ou corrida entre clientes diferentes.
- Não comite segredos, tokens nem credenciais.
- Não use Docker nem qualquer contêiner (docker, podman, `services:`/`container:` no GitHub Actions, imagens OCI), em desenvolvimento, testes, CI ou servidor. PostgreSQL e demais serviços rodam nativos. (definição da equipe, 27/11/2026, aceite do responsável pendente)
- Antes de abrir um PR, rode os testes e anexe o resultado no PR:

```sh
node --test scripts/*.test.mjs
bash scripts/pg-test.sh   # backend contra PostgreSQL nativo temporário (ou: npm test)
```

Para `ports/unity`, siga o README da pasta: `node --test Backend/rooms.test.mjs Tools/assets.test.mjs` e EditMode no Unity Test Runner.

## Direção do produto
O roteiro de decisões está no épico #19. Estas propostas ainda **não são regras** até o aceite na issue correspondente, mas orientam o trabalho:
- #2: padrões de engenharia (arquitetura orientada a eventos, módulos isolados, TDD, cobertura mínima de 80% no domínio, documentação de arquitetura, portões de CI).
- #3: Unity como engine única para Windows, Linux, iOS e Android com cross-play.
- #23: simulador da vida real. Todo comportamento sai das forças físicas, sem atalhos roteirizados, com tolerância de 2% em relação à polar de referência.
- #26: modelo genérico de embarcações e controles, para qualquer coisa que veleje: barcos, multicascos, foil, windsurf, kite e wing.

Quando uma proposta for aceita, este arquivo deve ser atualizado no mesmo PR que a registra.
