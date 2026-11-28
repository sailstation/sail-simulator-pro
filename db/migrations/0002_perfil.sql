-- Perfil do velejador: foto, país representado e clube (ADR-0006, issue #33).
-- Timestamps em milissegundos (Date.now()) como BIGINT, como nas demais tabelas.
CREATE TABLE clubs (
  id TEXT PRIMARY KEY,                    -- uuid (player), seed-<slug> (semente) ou osm-<node|way>-<id> (OpenStreetMap)
  name TEXT NOT NULL,
  country TEXT NOT NULL,                  -- ISO 3166-1 alfa-2, validado pela aplicação
  city TEXT,
  status TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'rejected')),
  source TEXT NOT NULL CHECK (source IN ('seed', 'osm', 'player')),
  verified BOOLEAN NOT NULL DEFAULT false, -- dados conferidos por humano; semente e importações nascem "a verificar"
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created BIGINT NOT NULL
);
CREATE INDEX clubs_name ON clubs (lower(name));
CREATE INDEX clubs_country ON clubs (country);
-- Perfil 1:1 com a conta; a exclusão da conta apaga foto e vínculos (LGPD, ADR-0006).
CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  country TEXT NOT NULL,                  -- ISO 3166-1 alfa-2
  club_id TEXT NOT NULL REFERENCES clubs(id),
  photo BYTEA,                            -- JPEG/PNG/WebP até 2 MB, validado pelos bytes iniciais
  photo_type TEXT CHECK (photo_type IN ('image/jpeg', 'image/png', 'image/webp')),
  photo_at BIGINT,                        -- ms do último envio; serve de ETag
  updated BIGINT NOT NULL,
  CHECK ((photo IS NULL) = (photo_type IS NULL))
);

-- Semente: clubes brasileiros reais com dados públicos (nome, cidade, país), marcados
-- "a verificar" (verified=false) até conferência humana. Fontes: sites oficiais dos clubes.
INSERT INTO clubs (id, name, city, country, status, source, verified, created) VALUES
  ('seed-icrj', 'Iate Clube do Rio de Janeiro', 'Rio de Janeiro', 'BR', 'approved', 'seed', false, 1795824000000),
  ('seed-veleiros-do-sul', 'Veleiros do Sul', 'Porto Alegre', 'BR', 'approved', 'seed', false, 1795824000000),
  ('seed-yacht-club-paulista', 'Yacht Club Paulista', 'São Paulo', 'BR', 'approved', 'seed', false, 1795824000000),
  ('seed-yacht-club-bahia', 'Yacht Club da Bahia', 'Salvador', 'BR', 'approved', 'seed', false, 1795824000000),
  ('seed-velejadores-da-lagoa', 'Associação dos Velejadores da Lagoa', 'Florianópolis', 'BR', 'approved', 'seed', false, 1795824000000);
