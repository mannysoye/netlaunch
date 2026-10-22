-- NetLaunch schema (Cloudflare D1 / SQLite).
-- Timestamps are unix epoch milliseconds.

CREATE TABLE users (
  id         TEXT PRIMARY KEY,           -- e.g. "github:12345" or "google:1089..."
  email      TEXT,
  name       TEXT,
  image      TEXT,
  created_at INTEGER NOT NULL
);

-- One conversation == one project == one website.
CREATE TABLE conversations (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,          -- "guest:<uuid>" or a users.id
  title          TEXT NOT NULL DEFAULT 'New site',
  stage          TEXT NOT NULL DEFAULT 'clarify'
                 CHECK (stage IN ('clarify','confirm','building','live','failed')),
  brief          TEXT NOT NULL DEFAULT '{}',   -- JSON, see worker/domain/brief.ts
  slug           TEXT UNIQUE,                  -- the page name: netpins.xyz/<slug>
  clarify_turns  INTEGER NOT NULL DEFAULT 0,
  pending_html   TEXT,                   -- generated HTML kept only if deploy failed (retry w/o re-spending AI tokens)
  last_error     TEXT,
  live_url       TEXT,
  site_bytes     INTEGER,
  building_since INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_conversations_owner ON conversations (owner_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  ui              TEXT,                  -- JSON: interactive card descriptor
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);

CREATE TABLE images (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  key             TEXT NOT NULL,         -- storage key of the draft copy
  filename        TEXT NOT NULL,         -- name inside the site: assets/<filename>
  role            TEXT NOT NULL,         -- logo | hero | gallery | other
  caption         TEXT,
  mime            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_images_conversation ON images (conversation_id);

-- Per-identity daily counters (quotas) and per-IP abuse guards.
CREATE TABLE usage (
  key   TEXT NOT NULL,                   -- identity id or "ip:<hash>"
  day   TEXT NOT NULL,                   -- YYYY-MM-DD (UTC)
  kind  TEXT NOT NULL,                   -- ai | build | stt | upload | guest_conv
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day, kind)
);
