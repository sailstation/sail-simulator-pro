# Registro de decisões arquiteturais (ADRs)

Leia este índice antes de propor ou implementar qualquer mudança. O fluxo está no [ADR-0001](0001-fluxo.md).

## ADRs no repositório

| ADR | Título | Estado | Issue |
| --- | --- | --- | --- |
| [0001](0001-fluxo.md) | Uma feature por vez | aceito | — |
| [0002](0002-repositorio-canonico.md) | Repositório canônico | proposto | #27 |
| [0003](0003-hospedagem-postgresql.md) | Hospedagem própria e PostgreSQL | proposto | #29 |
| [0004](0004-postgresql-banco-do-projeto.md) | PostgreSQL como banco do projeto | proposto | #31 |

Estados: **proposto** (aguardando aceite do responsável na issue), **aceito**, **substituído por ADR-NNNN**, **descontinuado**. ADR aceito não é editado; uma mudança gera um novo ADR que o substitui. O número é o próximo livre no momento do merge.

## Decisões propostas ainda em issue

O roteiro está no épico [#19](https://github.com/sailstation/sail-simulator-pro/issues/19). Cada issue com a label `adr` é uma decisão **proposta**: orienta o trabalho, mas não é regra até o aceite do responsável registrado na própria issue.

```sh
gh issue list -R sailstation/sail-simulator-pro --label adr --state open
gh issue view <N> -R sailstation/sail-simulator-pro --comments
```

Antes de implementar algo coberto por uma dessas issues, leia a issue inteira, inclusive os comentários, as seções "Definições da equipe" e "Perguntas para o responsável".
