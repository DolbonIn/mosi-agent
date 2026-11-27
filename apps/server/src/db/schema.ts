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
  /* v6: G3 — the person's settings revision (SettingsView.rev), raised with every settings write that changes a value,
     so devices tell a newer answer or event from an older one */ `
  ALTER TABLE users ADD COLUMN settings_rev INTEGER NOT NULL DEFAULT 0;
  `,
  /* v7 (agent-runtime 1848-b): a schedule's attached text file, read into every run; its name stays for the run and the
     card after the file is deleted. Columns added only: a schedule from before has neither (NULL) and runs as before */ `
  ALTER TABLE schedules ADD COLUMN attachment_id TEXT;
  ALTER TABLE schedules ADD COLUMN attachment_name TEXT;
  `,
  /* v8 (agent-runtime 2006 §2, 2052 §A): invest B1 — settings, watchlist, price rules and their watch state, sent alerts
     (dedupe_key UNIQUE), stop records (client_order_id UNIQUE), the code-written ledger, the last quotes, the shared
     source cache and pause state, rule previews and the invest call log. New tables only. */ `
  CREATE TABLE invest_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'mock',
    real_since INTEGER,
    calls_json TEXT NOT NULL DEFAULT '{}',
    thread_id TEXT,
    rev INTEGER NOT NULL DEFAULT 0,
    toss_checked_at INTEGER,
    toss_ok_at INTEGER,
    toss_error TEXT,
    toss_error_at INTEGER,
    toss_paused_until INTEGER,
    blind_since INTEGER,
    blind_banner_day TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE invest_watchlist (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    market TEXT NOT NULL,
    name TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, symbol)
  );
  CREATE TABLE invest_rules (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    level INTEGER,
    price REAL,
    lo REAL,
    hi REAL,
    direction TEXT NOT NULL,
    action TEXT NOT NULL,
    once INTEGER NOT NULL DEFAULT 0,
    buffer_pct REAL,
    conditions_json TEXT,
    until_day TEXT,
    state TEXT NOT NULL DEFAULT 'armed',
    hit_at INTEGER,
    hit_seq INTEGER NOT NULL DEFAULT 0,
    cleared_at INTEGER,
    paused_at INTEGER,
    seen_slot TEXT,
    real_confirmed_at INTEGER,
    rev INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX invest_rules_user ON invest_rules(user_id, symbol);
  CREATE TABLE invest_alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id TEXT,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    price REAL,
    observed_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    thread_id TEXT,
    message_id TEXT,
    call_state TEXT,
    called_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, dedupe_key)
  );
  CREATE INDEX invest_alerts_symbol ON invest_alerts(user_id, symbol, created_at);
  CREATE TABLE invest_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    mode TEXT NOT NULL,
    client_order_id TEXT NOT NULL UNIQUE,
    toss_order_id TEXT,
    state TEXT NOT NULL,
    qty REAL,
    filled_qty REAL,
    avg_price REAL,
    observed_price REAL NOT NULL,
    stop_price REAL NOT NULL,
    reason TEXT,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE invest_ledger (
    user_id TEXT NOT NULL DEFAULT '',
    id TEXT NOT NULL,
    as_of TEXT NOT NULL,
    published_at TEXT,
    value REAL,
    value_text TEXT,
    unit TEXT NOT NULL,
    definition TEXT NOT NULL,
    source_tier TEXT NOT NULL,
    url TEXT,
    revision TEXT,
    confidence TEXT NOT NULL,
    lead_class TEXT,
    author TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id, as_of)
  );
  CREATE TABLE invest_quotes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    prev_close REAL,
    source TEXT NOT NULL,
    as_of INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, symbol)
  );
  CREATE TABLE invest_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE invest_source_state (
    source TEXT PRIMARY KEY,
    paused_until INTEGER,
    last_status INTEGER,
    last_error TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE invest_previews (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE invest_calls (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    state TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX invest_calls_day ON invest_calls(user_id, at);
  `,
  // v9 (B1c): Web Push subscriptions, one per device endpoint; the session that sent it owns it (signing out drops it)
  `
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    last_status INTEGER
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id, created_at);
  CREATE INDEX push_subscriptions_session ON push_subscriptions(session_hash);
  `,
  // v10 (B2a, team-lead 0052 · 0056, DD 0109): the ledger's source name apart from its tier (T1–T4; v8 rows were all
  // quotes and ATRs from 토스증권 or Yahoo, both T2); the forecast ledger (B6: probability, interval, due day, criterion,
  // outcome, error cause); the event calendar and its D-1 reminders, one per person, event (market and title) and day
  // whichever way it went (a card now, the daily report's line in B2c)
  `
  ALTER TABLE invest_ledger ADD COLUMN source TEXT;
  UPDATE invest_ledger SET source = source_tier, source_tier = 'T2' WHERE source IS NULL;
  CREATE INDEX invest_ledger_recent ON invest_ledger(user_id, created_at);
  CREATE TABLE invest_forecasts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    made_on TEXT NOT NULL,
    claim TEXT NOT NULL,
    p REAL NOT NULL,
    lo REAL,
    hi REAL,
    unit TEXT,
    due_on TEXT NOT NULL,
    criterion TEXT NOT NULL,
    outcome TEXT,
    actual REAL,
    error_cause TEXT,
    resolved_at INTEGER,
    author TEXT NOT NULL,
    ledger_ids TEXT NOT NULL DEFAULT '[]',
    proposal_json TEXT,
    rev INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX invest_forecasts_user ON invest_forecasts(user_id, due_on);
  CREATE TABLE invest_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    market TEXT NOT NULL,
    day TEXT NOT NULL,
    time TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    symbol TEXT,
    source TEXT NOT NULL,
    source_tier TEXT NOT NULL,
    confidence TEXT NOT NULL,
    url TEXT,
    author TEXT NOT NULL,
    remind INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX invest_events_one ON invest_events(user_id, market, day, title);
  CREATE INDEX invest_events_day ON invest_events(day, user_id);
  CREATE TABLE invest_event_reminders (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    market TEXT NOT NULL,
    day TEXT NOT NULL,
    title TEXT NOT NULL,
    event_id TEXT NOT NULL,
    via TEXT NOT NULL,
    message_id TEXT,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, market, day, title)
  );
  `,
  // v11 (B2b-1, A12 · G8-5, DD 1935 §2-3): the model's rule proposals. A proposal changes nothing until the person taps
  // 바꾸기 on its card; it keeps the rules' revs it was made against (stale when any moved), the order mode and sellable
  // quantity its result sentence promised, and the card as shown (status and decidedAt follow the decision)
  `
  CREATE TABLE invest_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT,
    symbol TEXT NOT NULL,
    items_json TEXT NOT NULL,
    mode TEXT NOT NULL,
    qty INTEGER,
    card_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at INTEGER NOT NULL,
    decided_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX invest_proposals_open ON invest_proposals(status, expires_at);
  CREATE INDEX invest_proposals_user ON invest_proposals(user_id, created_at);
  `,
  // v12 (B2b-2, A2 · A5 · A6, DD 0059 §1, DD 0426): one stage reading per person and KST day, made at 08:00 (or at the
  // first beat after it); the board, the agent's invest_snapshot and the daily report all read this one row
  `
  CREATE TABLE invest_judgments (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    at INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
  );
  `,
  // v13 (B2c-1, A13 · A15, DD 0059 §2, team-lead 0747): one daily report per person and KST day. The row is taken
  // before the model is called (state making), so a second beat or a restart never calls it again; calls counts the
  // model calls (2 at most). json holds the eight sections and the card; the message is the invest thread's row.
  `
  CREATE TABLE invest_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('making', 'sent')),
    calls INTEGER NOT NULL DEFAULT 0,
    judged_at INTEGER NOT NULL,
    json TEXT,
    thread_id TEXT,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    UNIQUE (user_id, day)
  );
  CREATE INDEX invest_reports_user ON invest_reports (user_id, day DESC);
  `,
  // v14 (B2d-2a, team-lead 1550 · 1618): new events found in public calendars once a day from 07:00 KST. The KST day's
  // run row is taken first (one run a day; a second beat or a restart reads nothing again). A found event keeps its
  // source and item; deleting it marks that key for the person (source · item · day · symbol, '' without a symbol), so
  // the next run does not put it back.
  `
  CREATE TABLE invest_discovery (
    day TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('running', 'done')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    result TEXT
  );
  ALTER TABLE invest_events ADD COLUMN disc_source TEXT;
  ALTER TABLE invest_events ADD COLUMN disc_item TEXT;
  CREATE TABLE invest_event_dismissed (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    item TEXT NOT NULL,
    day TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT '',
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, source, item, day, symbol)
  );
  `,
];
