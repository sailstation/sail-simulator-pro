# ADR-0005 — Contas, login e confirmação de e-mail

Estado: proposto. Aguardando aceite do responsável pelo projeto na issue #32. O número é provisório e segue a ordem de merge.

Issue: sailstation/sail-simulator-pro#32 (depende da #15 e da #31).

Contexto: hoje o jogador entra numa sala só com nome, sem conta (ver #15). Loja, equipes, ranking e campanha exigem identidade verificada, e a equipe definiu (27/11/2026, aceite do responsável pendente) que o login passa a ser obrigatório antes do site, com captcha próprio por prova de trabalho e envio de e-mail pelo SMTP da cooperativa. O projeto evita serviços de terceiros quando há alternativa própria razoável e proíbe contêineres; o backend nativo com PostgreSQL é o do ADR-0004.

Alternativas:
- Provedor de identidade gerenciado (Auth0, Firebase, Unity Authentication): rápido, mas cria dependência externa, custo por usuário e envio de dados de jogadores a terceiros.
- Só login social (Steam, Apple, Google): exclui quem não tem conta nas plataformas e depende de terceiros; fica como complemento futuro, decidido na #15.
- Login próprio com e-mail e senha, captcha por prova de trabalho e SMTP da cooperativa: controle total, sem terceiros, ao custo de implementar e proteger o fluxo — é o que a equipe definiu.
- Para a senha: argon2id exigiria pacote nativo novo (compilação no deploy); `crypto.scrypt` já vem no Node com parâmetros equivalentes recomendados pela OWASP.
- Para o e-mail: `nodemailer` (sem dependências próprias, mas uma base de código grande para o uso que temos) contra um cliente SMTP mínimo em Node puro, cobrindo só o caminho necessário (EHLO, STARTTLS ou TLS implícito, AUTH LOGIN, um destinatário, texto puro).

Decisão:
- **Login próprio obrigatório antes do site.** Sem sessão válida, os estáticos de `dist/` redirecionam para `/login.html` e a API de salas responde 401. Ficam públicos apenas `/login.html`, `login.css`, `login.js` e a foto oficial (`sail-simulator-pro-splash.webp`, otimizada da imagem do handoff), além de `/__deploy` e `/api/auth/*`.
- **Contas** em `db/migrations/0001_contas.sql`: `users` (e-mail único normalizado em minúsculas, hash de senha, `confirmed`, `created`), `sessions`, `email_tokens` e `auth_attempts`. Timestamps em ms como BIGINT, como no restante do banco.
- **Senha com `crypto.scrypt`** (N=2^17, r=8, p=1, salt de 16 bytes, chave de 32), sem dependência nova; o hash gravado carrega os parâmetros (`scrypt$N$r$p$salt$chave`). Comparação com `timingSafeEqual` e hash descartável para o login com e-mail inexistente gastar o mesmo tempo. Mínimo de 10 caracteres.
- **Sessões revogáveis**: token aleatório de 32 bytes no cookie `sail_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`, 30 dias); o banco guarda só o SHA-256 do token. Sair encerra a sessão; "sair de todos os dispositivos" e a redefinição de senha encerram todas.
- **Confirmação de e-mail e recuperação de senha** por links com token aleatório de 32 bytes, guardado como hash, de uso único (apagado ao usar) e com validade (24 h e 1 h). A redefinição revoga as sessões. As respostas não revelam se um e-mail tem conta.
- **Captcha próprio por prova de trabalho** (`server/pow.mjs`), sem terceiros: desafio `id.expiração.dificuldade` assinado com HMAC-SHA256 (segredo em `SAIL_POW_SECRET`, dificuldade em `SAIL_POW_BITS`, padrão 16 bits ≈ 65 mil hashes); o navegador resolve com Web Crypto; o servidor valida em uma única hash, com validade curta (5 min) e uso único. Exigido no cadastro, na recuperação e no reenvio de confirmação; o login é protegido pelo limite de tentativas.
- **Limite de tentativas com bloqueio progressivo** por e-mail e por IP: 5 falhas de login por e-mail e 20 por IP em 15 min disparam bloqueio de 1 min que dobra a cada nova falha até 15 min; cadastro e recuperação limitados a 10 pedidos por IP por hora. Sucesso no login zera o contador. O IP vem de `X-Forwarded-For` — seguro porque o processo só escuta em 127.0.0.1 atrás do Caddy.
- **E-mail por cliente SMTP mínimo em Node puro** (`server/mail.mjs`), sem dependência nova: configurado por `SMTP_HOST`, `SMTP_PORT` (587 com STARTTLS; 465 com TLS implícito; `SMTP_TLS=off` para relay local), `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM`. Sem `SMTP_HOST`, o e-mail vai para o log (modo desenvolvimento) em vez de falhar. Cabeçalhos com CRLF são rejeitados e o corpo sai em base64. Justificativa: o uso é um único caminho estreito (texto puro, um destinatário), a superfície fica toda sob teste com um servidor SMTP falso em processo, e o projeto evita dependências; se o SMTP real da cooperativa expuser exigências fora desse caminho, a troca por `nodemailer` é localizada em um arquivo.
- **Segredos só em ambiente**: `SAIL_POW_SECRET` e `SMTP_*` ficam em `/opt/sail/<ambiente>.secrets.env` no servidor (lido pela unit `sail@`, fora do GitOps), nunca no repositório. `SAIL_BASE_URL` (não secreta) define o domínio dos links dos e-mails.
- **CSRF**: cookie `SameSite=Lax` (não acompanha POST de outro site) somada à verificação de `Origin` em todas as rotas POST da API, quando o navegador a envia. Sem token sincronizador por ora: as rotas mudam estado só via POST JSON, e a combinação cobre os navegadores suportados.
- **Cabeçalhos de segurança** em todas as respostas: CSP `default-src 'self'` (com `style-src 'unsafe-inline'` para o jogo), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- **Rota de teste** `/api/auth/test-confirm` confirma a conta sem e-mail, registrada somente quando `SAIL_ENV=test`, para o `deploy/e2e.mjs` passar pelo fluxo completo no ambiente de teste (público e sem dados reais).
- Migrações passam a rodar sob trava consultiva do PostgreSQL, serializando processos que migram ao mesmo tempo.
- O health check do `deploy.sh` passa a aceitar 401 (releases com login) além de 404.

Consequências:
- O backend guarda contas e sessões no PostgreSQL; cada requisição de estático ou de API consulta a sessão no banco (custo aceitável na escala atual).
- O servidor precisa de acesso SMTP configurado por ambiente; sem ele, os e-mails saem no log e a confirmação de contas em produção fica inviável — configurar o SMTP é pré-requisito para abrir o cadastro.
- O captcha por prova de trabalho custa CPU do aparelho do jogador; 16 bits ficam em ~1 s num celular médio e a dificuldade é ajustável por ambiente sem novo deploy de código.
- Sem segredo `SAIL_POW_SECRET` o processo gera um aleatório na partida (desafios em aberto morrem no restart) e avisa no log; produção deve definir o segredo.
- A foto oficial entra no repositório otimizada (WebP, ~150 KB); o PNG original fica no branch de handoff.
- O TLS do cliente SMTP (STARTTLS/465) não é exercido pelos testes automatizados (exigiria certificado); fica validado na configuração do SMTP real. A CSP não foi validada em navegador real ainda.
- Login social e MFA continuam na #15; perfil (nome, foto, clube) fica para issue própria.

Critérios de validação: os critérios de aceite da #32; `node --test` com PostgreSQL real e cobertura ≥ 80% em `server/`, localmente e no CI; `deploy/e2e.mjs` passa no ambiente de teste cobrindo cadastro, confirmação, login, salas e logout; bloqueio temporário de login coberto por teste automatizado; revisão de segurança do fluxo antes do merge; aceite do responsável na issue #32.
