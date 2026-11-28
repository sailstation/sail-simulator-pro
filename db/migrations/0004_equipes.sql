-- Equipes, convites e chat da equipe (ADR-0007, issue #34): escuderias persistentes como
-- base das tripulações da regata por equipes (#22). Timestamps em milissegundos (Date.now())
-- como BIGINT, como nas demais tabelas.
CREATE TABLE teams (
  id TEXT PRIMARY KEY,                    -- uuid
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL UNIQUE,         -- lower + espaços colapsados, gravado pela aplicação
  tag TEXT NOT NULL,                      -- sigla exibida, em maiúsculas
  tag_norm TEXT NOT NULL UNIQUE,
  country TEXT,                           -- ISO 3166-1 alfa-2, opcional, validado pela aplicação
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created BIGINT NOT NULL
);
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('captain', 'member')),
  is_primary BOOLEAN NOT NULL DEFAULT false, -- equipe principal do jogador (ADR-0007)
  joined BIGINT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
-- Um capitão por equipe e uma equipe principal por jogador, garantidos pelo banco.
CREATE UNIQUE INDEX team_members_one_captain ON team_members(team_id) WHERE role = 'captain';
CREATE UNIQUE INDEX team_members_one_primary ON team_members(user_id) WHERE is_primary;
CREATE INDEX team_members_user ON team_members(user_id);
-- Convites: exatamente um destinatário — conta (por nome de exibição), e-mail (não resolvido,
-- para não revelar se a conta existe) ou token de link (só o hash é gravado, ADR-0005).
CREATE TABLE team_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  invitee TEXT REFERENCES users(id) ON DELETE CASCADE,   -- convite por nome de exibição
  invitee_email TEXT,                                    -- convite por e-mail, normalizado
  token_hash TEXT UNIQUE,                                -- convite por link; o token só existe no link
  max_uses INTEGER,                                      -- links: 1..50; demais: NULL (uso único)
  uses INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  created BIGINT NOT NULL,
  expires BIGINT NOT NULL,
  CHECK (num_nonnulls(invitee, invitee_email, token_hash) = 1)
);
CREATE INDEX team_invites_invitee ON team_invites(invitee) WHERE status = 'pending';
CREATE INDEX team_invites_email ON team_invites(invitee_email) WHERE status = 'pending';
CREATE INDEX team_invites_team ON team_invites(team_id, status);
CREATE INDEX team_invites_sender ON team_invites(invited_by, created);
-- Chat da equipe: id BIGSERIAL é o cursor do histórico (before) e do polling (after).
-- Remoção é tombstone (deleted preenchido e corpo esvaziado) para os clientes removerem a
-- mensagem no próximo polling; a denúncia guarda a cópia do texto.
CREATE TABLE team_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created BIGINT NOT NULL,
  deleted BIGINT
);
CREATE INDEX team_messages_team ON team_messages(team_id, id);
CREATE INDEX team_messages_author ON team_messages(user_id, created);
CREATE TABLE team_message_reports (
  id TEXT PRIMARY KEY,
  message_id BIGINT NOT NULL,             -- sem FK: a mensagem pode virar tombstone ou sumir
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  reporter TEXT REFERENCES users(id) ON DELETE SET NULL,
  reported_user TEXT,                     -- autor no momento da denúncia (sem FK, como message_id)
  excerpt TEXT NOT NULL,                  -- cópia do texto denunciado
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created BIGINT NOT NULL
);
CREATE INDEX team_message_reports_open ON team_message_reports(created) WHERE status = 'open';
CREATE INDEX team_message_reports_reporter ON team_message_reports(reporter, created);
