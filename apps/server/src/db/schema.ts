/**
 * SQLite schema. Migrations are applied in order and tracked with `PRAGMA user_version`;
 * never edit a shipped migration — append a new one.
 */

export const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    handle         TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL,
    agent_name     TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    settings_json  TEXT NOT NULL,
    main_thread_id TEXT,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE devices (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id           TEXT NOT NULL,
    label        TEXT NOT NULL,
    signing_jwk  TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id    TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE threads (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    subtitle    TEXT NOT NULL DEFAULT '',
    icon        TEXT NOT NULL,
    auto_title  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE thread_members (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    archived  INTEGER NOT NULL DEFAULT 0,
    unread    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, user_id)
  );
  CREATE INDEX thread_members_user ON thread_members(user_id);

  CREATE TABLE messages (
    id               TEXT PRIMARY KEY,
    thread_id        TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role             TEXT NOT NULL,
    text             TEXT NOT NULL,
    cards_json       TEXT NOT NULL DEFAULT '[]',
    tools_json       TEXT NOT NULL DEFAULT '[]',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    author_user_id   TEXT,
    author_kind      TEXT,
    llm_json         TEXT,
    steered          INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX messages_thread ON messages(thread_id, created_at);

  CREATE TABLE approvals (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id           TEXT NOT NULL,
    message_id          TEXT NOT NULL,
    call_json           TEXT NOT NULL,
    prior_messages_json TEXT NOT NULL,
    spec_json           TEXT NOT NULL,
    status              TEXT NOT NULL,
    nonce               TEXT,
    device_verified     INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    resolved_at         INTEGER,
    expires_at          INTEGER NOT NULL
  );
  CREATE INDEX approvals_user ON approvals(user_id, status);

  CREATE TABLE credentials (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service      TEXT NOT NULL,
    label        TEXT NOT NULL,
    kind         TEXT NOT NULL,
    hint         TEXT NOT NULL,
    keep_for     TEXT NOT NULL,
    expires_at   INTEGER,
    sealed       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    use_count    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX credentials_user ON credentials(user_id);

  CREATE TABLE user_keys (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    wrapped    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE access_log (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id   TEXT,
    service         TEXT NOT NULL,
    service_name    TEXT NOT NULL,
    action          TEXT NOT NULL,
    purpose         TEXT NOT NULL,
    actor           TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    device_verified INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX access_log_user ON access_log(user_id, created_at);

  CREATE TABLE connections (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider      TEXT NOT NULL,
    status        TEXT NOT NULL,
    account_label TEXT,
    credential_id TEXT,
    last_error    TEXT,
    connected_at  INTEGER,
    updated_at    INTEGER NOT NULL,
    meta          TEXT,
    PRIMARY KEY (user_id, provider)
  );

  CREATE TABLE artifacts (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id  TEXT,
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX artifacts_user ON artifacts(user_id, created_at);

  CREATE TABLE attachments (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id  TEXT,
    filename   TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_user ON attachments(user_id, created_at);

  -- tokens = everything consumed that day (stats); counted = what counts toward the quota (tickets reset it)
  CREATE TABLE usage (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kst_day TEXT NOT NULL,
    tokens  INTEGER NOT NULL DEFAULT 0,
    counted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, kst_day)
  );

  CREATE TABLE tickets (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    basic   INTEGER NOT NULL DEFAULT 3,
    premium INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE templates (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    icon        TEXT NOT NULL,
    hue         INTEGER NOT NULL,
    prompt      TEXT NOT NULL,
    skills_json TEXT NOT NULL,
    sort        INTEGER NOT NULL,
    hidden      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE template_counts (
    template_id TEXT PRIMARY KEY,
    count       INTEGER NOT NULL DEFAULT 0
  );

  -- directed rows: (user_id → friend_id); an accepted friendship has both directions
  CREATE TABLE friends (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT NOT NULL,
    thread_id  TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  );

  CREATE TABLE invites (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    uses       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE schedules (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    prompt      TEXT NOT NULL,
    rule        TEXT NOT NULL,
    human       TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    thread_id   TEXT,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX schedules_due ON schedules(enabled, next_run_at);
  CREATE INDEX schedules_user ON schedules(user_id);

  CREATE TABLE kv (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  `,
  /* v2: Google Meet participation (meet.ts) — one row per join, one per utterance heard or said */ `
  CREATE TABLE meetings (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id    TEXT NOT NULL,
    session_id   TEXT,
    code         TEXT NOT NULL,
    purpose      TEXT NOT NULL DEFAULT '',
    state        TEXT NOT NULL,
    reason       TEXT,
    participants INTEGER,
    last_seq     INTEGER NOT NULL DEFAULT 0,
    started_at   INTEGER NOT NULL,
    joined_at    INTEGER,
    ended_at     INTEGER
  );
  CREATE INDEX meetings_user ON meetings(user_id, started_at);
  CREATE INDEX meetings_state ON meetings(state);

  CREATE TABLE meet_utterances (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    seq        INTEGER,
    speaker    TEXT,
    text       TEXT NOT NULL,
    start_ms   INTEGER,
    end_ms     INTEGER,
    at         INTEGER NOT NULL,
    role       TEXT NOT NULL DEFAULT 'heard',
    UNIQUE (meeting_id, seq)
  );
  CREATE INDEX meet_utterances_at ON meet_utterances(meeting_id, at);
  `,
  /* v3: the Meet page title (services/meet GET /sessions/:id), for sys_meet_notes and the prompt note */ `
  ALTER TABLE meetings ADD COLUMN title TEXT;
  `,
  /* v4: explore counts are real delegations only. Up to v3 the server seeded made-up counts ("17,166명이 맡겼어요");
     take exactly the seeded amount back out of each row, so the delegations made since stay */ `
  UPDATE template_counts SET count = MAX(0, count - CASE template_id
      WHEN 'call-demo' THEN 17166
      WHEN 'gov-benefits' THEN 7734
      WHEN 'morning-briefing' THEN 5120
      WHEN 'news-briefing' THEN 3655
      WHEN 'stock-watch' THEN 1180
      WHEN 'outlet-trip' THEN 2410
      WHEN 'jeju-trip' THEN 4480
      WHEN 'holiday-plan' THEN 2560
      WHEN 'travel-safety' THEN 1870
      WHEN 'kakao-unread' THEN 3901
      WHEN 'slack-digest' THEN 2214
      WHEN 'friend-relay' THEN 2105
      WHEN 'weekend-shows' THEN 3388
      WHEN 'library-books' THEN 1420
      WHEN 'han-river' THEN 1980
      WHEN 'subway-commute' THEN 4212
      WHEN 'airport-drive' THEN 2950
      WHEN 'fine-dust' THEN 1090
      WHEN 'apt-prices' THEN 3120
      WHEN 'school-lunch' THEN 1640
      WHEN 'law-easy' THEN 1310
      WHEN 'housing-notices' THEN 2680
      WHEN 'crowd-check' THEN 2290
      WHEN 'suggest-wakeup' THEN 960
      WHEN 'connect-kakao' THEN 1210
      ELSE 0 END);
  `,
  /* v5: meeting B — the chat thread a join was asked in and the approval that let it, so the join card there can
     follow its meeting (GET /api/threads/:id/meet?approval=) and the end summary is posted there too */ `
  ALTER TABLE meetings ADD COLUMN origin_thread_id TEXT;
  ALTER TABLE meetings ADD COLUMN approval_id TEXT;
  CREATE INDEX meetings_approval ON meetings(user_id, approval_id);
  `,
];
