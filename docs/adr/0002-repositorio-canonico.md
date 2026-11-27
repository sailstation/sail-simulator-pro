# ADR-0002 — Repositório canônico

Estado: proposto. Aguardando aceite do responsável pelo projeto na issue #27.

Issue: sailstation/sail-simulator-pro#27.

Contexto: o projeto começou em gvestphal-glitch/sail-simulator-pro. Um servidor passará a sincronizar automaticamente as alterações feitas no Git, e ele precisa de uma única origem. Issues e PRs espalhados em dois repositórios quebram o fluxo do ADR-0001 e confundem pessoas e agentes de IA.

Alternativas: manter o repositório original como canônico; usar os dois em paralelo; adotar o fork sailstation/sail-simulator-pro como canônico.

Decisão: sailstation/sail-simulator-pro é o repositório canônico. Issues, branches de feature e PRs são abertos somente nele. O repositório original fica como `upstream` histórico. As issues abertas no original foram recriadas no canônico com numeração nova (número antigo − 2) e fechadas no original com link, conforme o aviso gvestphal-glitch/sail-simulator-pro#28. O fluxo do ADR-0001 continua valendo sem alteração.

Consequências: referências a issues anteriores à transferência devem usar o nome completo do repositório (gvestphal-glitch/sail-simulator-pro#N). Clones existentes precisam apontar `origin` para o repositório canônico. A publicação do jogo pelo servidor segue a `main` do repositório canônico.

Critérios de validação: README e AGENTS.md indicam o repositório canônico; nenhuma issue aberta permanece no repositório original além do aviso; aceite do responsável registrado na issue.
