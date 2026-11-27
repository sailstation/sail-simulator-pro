-- Contas, sessões, tokens de e-mail e tentativas de autenticação (login obrigatório, ADR-0005).
-- Timestamps em milissegundos (Date.now()) como BIGINT, como nas salas.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,            -- normalizado em minúsculas pela aplicação
  pass TEXT NOT NULL,                    -- scrypt$N$r$p$salt$hash (salt e hash em base64)
  confirmed BIGINT,                      -- ms da confirmação do e-mail; NULL = pendente
  created BIGINT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,           -- sha256 hex do token; o token em claro só existe no cookie
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created BIGINT NOT NULL,
  expires BIGINT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiration ON sessions(expires);
CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,           -- sha256 hex do token enviado por e-mail; uso único (apagado ao usar)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('confirm', 'recover')),
  expires BIGINT NOT NULL
);
CREATE INDEX email_tokens_user ON email_tokens(user_id, kind);
-- Limite de tentativas com bloqueio temporário progressivo, por IP e por e-mail.
CREATE TABLE auth_attempts (
  scope TEXT NOT NULL,                   -- 'ip' ou 'email' (com prefixo da finalidade quando aplicável)
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  first BIGINT NOT NULL,
  blocked_until BIGINT,
  PRIMARY KEY (scope, key)
);
