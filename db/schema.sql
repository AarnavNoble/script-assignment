-- Script assignment schema.
-- All timestamps come from Postgres now(); the browser and app-server clocks are never trusted.

CREATE TABLE contributors (
  id        int PRIMARY KEY,
  language  text NOT NULL
);

-- Script lifecycle:
--   available -> claimed -> submitted -> approved
--   claimed   -> available            (lease expired, or released)
--   submitted -> available            (recording rejected: the script still needs a good take)
CREATE TABLE scripts (
  id               bigserial PRIMARY KEY,
  language         text NOT NULL,
  body             text NOT NULL,
  status           text NOT NULL DEFAULT 'available'
                   CHECK (status IN ('available','claimed','submitted','approved')),
  claimed_by       int REFERENCES contributors(id),
  claim_token      uuid,
  claimed_at       timestamptz,
  lease_expires_at timestamptz,
  -- Token of a lease that expired without anyone re-claiming the script.
  -- Lets a late (stalled) contributor still submit; cleared the moment someone else claims.
  prev_token       uuid,
  prev_claimed_by  int REFERENCES contributors(id),
  times_claimed    int NOT NULL DEFAULT 0,
  CHECK ((status = 'claimed') = (claimed_by IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
-- the claim query scans this: free or possibly-expired rows per language, in id order
CREATE INDEX scripts_free ON scripts (language, id) WHERE status IN ('available','claimed');
CREATE INDEX scripts_claimed_expiry ON scripts (lease_expires_at) WHERE status = 'claimed';
CREATE UNIQUE INDEX scripts_claim_token ON scripts (claim_token) WHERE claim_token IS NOT NULL;
CREATE INDEX scripts_prev_token ON scripts (prev_token) WHERE prev_token IS NOT NULL;
-- a contributor holds at most one claimed script
CREATE UNIQUE INDEX one_claim_per_contributor ON scripts (claimed_by) WHERE status = 'claimed';

-- Recording lifecycle:
--   pending_checks -> approved | rejected | needs_review
--   needs_review   -> approved | rejected
--   approved       -> paid
CREATE TABLE recordings (
  id             bigserial PRIMARY KEY,
  script_id      bigint NOT NULL REFERENCES scripts(id),
  contributor_id int NOT NULL REFERENCES contributors(id),
  claim_token    uuid NOT NULL UNIQUE,          -- one recording per claim; makes submit idempotent
  s3_key         text NOT NULL,
  size_bytes     bigint NOT NULL,
  late           boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'pending_checks'
                 CHECK (status IN ('pending_checks','needs_review','approved','rejected','paid')),
  -- filled by the QA worker
  duration_s     real,
  silence_ratio  real,
  clipping_ratio real,
  peak_db        real,
  rms_db         real,
  audio_sha256   text,
  checks         jsonb,
  est_pay_cents  int,               -- "estimated" until approved
  reviewed_at    timestamptz,
  review_note    text,
  paid_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- a script never has two live recordings; a rejected one doesn't count, so the script can be re-recorded
CREATE UNIQUE INDEX one_live_recording_per_script ON recordings (script_id) WHERE status <> 'rejected';
CREATE INDEX recordings_status ON recordings (status, created_at);
CREATE INDEX recordings_sha ON recordings (audio_sha256) WHERE audio_sha256 IS NOT NULL;

-- Append-only audit log. Powers the invariant checker, metrics and the ops view.
CREATE TABLE claim_events (
  id               bigserial PRIMARY KEY,
  script_id        bigint,
  contributor_id   int,
  claim_token      uuid,
  -- claimed|resumed|heartbeat|lost|released|expired|submitted|late_accepted|rejected|pool_empty
  -- |qa_approved|qa_rejected|qa_review|review_approved|review_rejected|paid
  event            text NOT NULL,
  language         text,
  -- clock_timestamp(), not now(): the event is stamped when written (after its row change), not when its
  -- transaction began, so the log never shows a claim before the release that freed the row
  at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz,
  detail           jsonb
);
CREATE INDEX claim_events_script ON claim_events (script_id, at);
CREATE INDEX claim_events_at ON claim_events (at);
CREATE INDEX claim_events_contributor ON claim_events (contributor_id, at);
-- token -> script lookup (fenced heartbeats and submits); one 'claimed' row per token
CREATE INDEX claim_events_token ON claim_events (claim_token) WHERE event = 'claimed';

-- Written by the background job, one row per language per run.
CREATE TABLE pool_stats (
  at                 timestamptz NOT NULL DEFAULT now(),
  language           text NOT NULL,
  available          int NOT NULL,   -- includes claimed rows whose lease has expired
  claimed            int NOT NULL,   -- live leases only
  submitted          int NOT NULL,
  approved           int NOT NULL,
  claims_last_window int NOT NULL,
  hours_left         real            -- NULL when nobody claimed in the window
);
CREATE INDEX pool_stats_at ON pool_stats (at, language);

CREATE TABLE alerts (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  kind      text NOT NULL,           -- low_pool|pool_empty|orphans|abandonment
  language  text,
  message   text NOT NULL,
  detail    jsonb
);
