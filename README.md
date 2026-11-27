# Sail Simulator Pro

Simulador de regatas da Sailing Solutions e Sail Station. O jogo publicado está em dist/. O backend multiplayer (salas) fica em server/, com migrações em db/migrations/ e PostgreSQL como banco ([ADR-0004](docs/adr/0004-postgresql-banco-do-projeto.md)). As versões Unity e Godot ficam em ports/, cada uma com seu próprio README; `ports/unity/Backend` é uma cópia legada do backend antigo (Worker/D1), sem evolução.

## Desenvolvimento web

Use Node.js 22 ou superior. Na raiz do repositório:

```sh
npm ci --ignore-scripts
node --test scripts/*.test.mjs   # testes do cliente
bash scripts/pg-test.sh          # testes do backend contra PostgreSQL nativo temporário
node server/main.mjs             # backend + estáticos (exige DATABASE_URL e PostgreSQL)
```

Abra http://localhost:9000 para jogar localmente (ou a porta definida em PORT). As salas multiplayer dependem do backend e do banco.

## Publicação

Produção em https://sail-pro.sailstation.com (segue a `main` testada) e teste em https://sail-test.sailstation.com (último push em PR). O servidor usa PostgreSQL e está descrito em [docs/infra/servidor.md](docs/infra/servidor.md).

## Contribuição

O repositório canônico é [sailstation/sail-simulator-pro](https://github.com/sailstation/sail-simulator-pro) ([ADR-0002](docs/adr/0002-repositorio-canonico.md)). Issues e PRs são abertos somente nele.

Siga [ADR-0001](docs/adr/0001-fluxo.md). Abra uma issue com objetivo e critérios de aceite. Registre a decisão antes de implementar. Trabalhe em uma branch por issue e vincule seu PR usando Closes #N. A próxima feature começa após o encerramento do PR da anterior.

Agentes de IA e colaboradores devem ler o [AGENTS.md](AGENTS.md) antes de alterar o projeto.
