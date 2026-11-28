-- Avatar por emoji (ADR-0006, issue #33; definição da equipe de 28/11/2026): a foto deixa de
-- ser obrigatória e quem não a envia aparece com um emoji da lista curada, validada no servidor
-- (server/profile.mjs). O padrão ⛵ vale também para as contas existentes, que seguem completas.
-- A lista não vira CHECK no banco: ela é curada na aplicação e mudanças nela não pedem migração.
ALTER TABLE profiles ADD COLUMN avatar_emoji TEXT NOT NULL DEFAULT '⛵';
