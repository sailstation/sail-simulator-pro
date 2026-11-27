-- Equivalente PostgreSQL de drizzle/0000_regatta_rooms.sql (D1/SQLite).
-- Timestamps em milissegundos (Date.now()) exigem BIGINT.
CREATE TABLE rooms (
  code TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  created BIGINT NOT NULL,
  expires BIGINT NOT NULL,
  starts BIGINT
);
CREATE TABLE sailors (
  room TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 5),
  id TEXT NOT NULL,
  token TEXT NOT NULL,
  name TEXT NOT NULL,
  seen BIGINT NOT NULL,
  boat TEXT,
  PRIMARY KEY (room, seat),
  UNIQUE (room, id)
);
CREATE INDEX rooms_expiration ON rooms(expires);
