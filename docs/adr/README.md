# Registro de decisões arquiteturais (ADRs)

Leia este índice antes de propor ou implementar qualquer mudança. O fluxo está no [ADR-0001](0001-fluxo.md).

## ADRs no repositório

| ADR | Título | Estado | Issue |
| --- | --- | --- | --- |
| [0001](0001-fluxo.md) | Uma feature por vez | aceito | — |
| [0002](0002-repositorio-canonico.md) | Repositório canônico | aceito (28/11/2026, por delegação) | #27 |
| [0003](0003-hospedagem-postgresql.md) | Hospedagem própria e PostgreSQL | aceito (28/11/2026, por delegação) | #29 |
| [0004](0004-postgresql-banco-do-projeto.md) | PostgreSQL como banco do projeto | aceito (28/11/2026, por delegação) | #31 |
| [0005](0005-contas-login-confirmacao-email.md) | Contas, login e confirmação de e-mail | aceito (28/11/2026, por delegação) | #32 |
| [0006](0006-perfil-velejador.md) | Perfil do velejador: nome, país, clube e avatar | aceito com ajuste (28/11/2026, por delegação) | #33 |
| [0007](0007-equipes-convites-chat.md) | Equipes, convites e chat da equipe | aceito (28/11/2026, por delegação) | #34 |
| [0008](0008-progressao-pontos-licencas.md) | Progressão, pontos e licenças | aceito (28/11/2026, por delegação) | #36, #35 |

Aceites de 28/11/2026: por delegação do Marcos e do Guilherme, com o comentário de decisão na issue correspondente e a lista completa em [docs/decisoes/2026-11-28.md](../decisoes/2026-11-28.md). Revisão de qualquer uma: novo ADR.

Estados: **proposto** (aguardando aceite do responsável na issue), **aceito**, **substituído por ADR-NNNN**, **descontinuado**. ADR aceito não é editado; uma mudança gera um novo ADR que o substitui. O número é o próximo livre no momento do merge.

## Decisões propostas ainda em issue

O roteiro está no épico [#19](https://github.com/sailstation/sail-simulator-pro/issues/19). As issues #2 a #18, #22, #23 e #26 receberam decisão registrada em comentário em 28/11/2026 (por delegação, revisável — ver [docs/decisoes/2026-11-28.md](../decisoes/2026-11-28.md)); o arquivo de ADR de cada uma nasce no PR que implementar a feature correspondente.

```sh
gh issue list -R sailstation/sail-simulator-pro --label adr --state open
gh issue view <N> -R sailstation/sail-simulator-pro --comments
```

Antes de implementar algo coberto por uma dessas issues, leia a issue inteira, inclusive os comentários, as seções "Definições da equipe" e "Perguntas para o responsável".
