CREATE TABLE IF NOT EXISTS comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id   uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text NOT NULL CHECK (length(btrim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz
);
CREATE INDEX IF NOT EXISTS comments_issue_idx ON comments (issue_id, created_at);
