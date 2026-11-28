-- Progressão da Campanha: pontos, licenças, provas e resultados de sala (ADR-0008, issues
-- #35/#36). Timestamps em milissegundos (Date.now()) como BIGINT, como nas demais tabelas.
-- A sala ganha o encerramento pelo anfitrião e a vaga ganha o vínculo com a conta — sem conta
-- não há a quem pontuar (velejador sem sessão segue podendo correr em sala aberta).
ALTER TABLE rooms ADD COLUMN finished BIGINT;
ALTER TABLE sailors ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
-- Resultado de sala encerrada: quem chegou em que posição. Sem FK para rooms de propósito:
-- a sala expira e é apagada; o resultado esportivo fica.
CREATE TABLE room_results (
  id TEXT PRIMARY KEY,                   -- uuid
  room TEXT NOT NULL,                    -- código da sala no momento do encerramento
  boat_class TEXT NOT NULL,              -- classe da raia (settings.boatClass)
  mode TEXT NOT NULL CHECK (mode IN ('iniciante', 'avancado')),
  humans INTEGER NOT NULL,               -- participantes presentes no encerramento
  verification TEXT NOT NULL DEFAULT 'client' CHECK (verification IN ('client', 'server')),
  created BIGINT NOT NULL
);
CREATE INDEX room_results_room ON room_results(room);
CREATE TABLE room_result_entries (
  result_id TEXT NOT NULL REFERENCES room_results(id) ON DELETE CASCADE,
  seat INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL, -- apagar a conta preserva o registro da flotilha
  name TEXT NOT NULL,                    -- nome na sala no encerramento (registro esportivo)
  position INTEGER,                      -- 1..n entre os que cruzaram a linha; NULL = não terminou
  finish DOUBLE PRECISION,               -- tempo de chegada em segundos; NULL = não terminou
  points INTEGER NOT NULL DEFAULT 0,     -- pontos lançados por esta linha (0 = não pontuou)
  PRIMARY KEY (result_id, seat)
);
CREATE INDEX room_result_entries_user ON room_result_entries(user_id) WHERE user_id IS NOT NULL;
-- Livro-razão de pontos: SÓ ACRÉSCIMO — nunca UPDATE nem DELETE pela aplicação; o saldo é a
-- soma dos lançamentos. Ajuste manual de moderação é um lançamento 'adjustment' via SQL
-- (docs/infra/servidor.md).
CREATE TABLE point_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points INTEGER NOT NULL CHECK (points <> 0),
  source TEXT NOT NULL CHECK (source IN ('room', 'achievement', 'adjustment')),
  source_ref TEXT,                       -- room_results.id quando a origem é sala; NULL nos demais
  reason TEXT NOT NULL,                  -- texto exibido no extrato da carreira
  verification TEXT NOT NULL DEFAULT 'client' CHECK (verification IN ('client', 'server')),
  created BIGINT NOT NULL
);
CREATE INDEX point_entries_user ON point_entries(user_id, id);
-- Provas (conquistas): 'tutorial:<classe>' e 'regata-limpa' reportadas pelo cliente;
-- 'regatas:<n>' (marcos de regatas completas no Avançado) computadas pelo servidor.
CREATE TABLE achievements (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('client', 'room', 'adjustment')),
  verification TEXT NOT NULL DEFAULT 'client' CHECK (verification IN ('client', 'server')),
  created BIGINT NOT NULL,
  PRIMARY KEY (user_id, achievement)
);
-- Licenças conquistadas (estilo ACC/rFactor 2): registradas na primeira vez que os requisitos
-- são atingidos e não se perdem por queda de pontos; revogação é ato de moderação, por SQL.
CREATE TABLE license_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  license TEXT NOT NULL,
  created BIGINT NOT NULL,
  PRIMARY KEY (user_id, license)
);
