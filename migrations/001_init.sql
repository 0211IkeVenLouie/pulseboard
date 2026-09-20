CREATE TABLE IF NOT EXISTS boards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  title        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('retro', 'kanban')),
  cards_hidden boolean NOT NULL DEFAULT false,
  is_demo      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS columns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title      text NOT NULL,
  sort_key   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS columns_board_idx ON columns (board_id, sort_key);

CREATE TABLE IF NOT EXISTS cards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id   uuid NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  body        text NOT NULL,
  -- Fractional index: an insert between two cards only writes the moved row,
  -- so concurrent moves never fight over a shared "position" integer.
  sort_key    text NOT NULL,
  -- Optimistic-concurrency guard. Every mutating op carries the version it read;
  -- a stale drag is rejected instead of silently overwriting a newer move.
  version     integer NOT NULL DEFAULT 1,
  author_id   text NOT NULL,
  author_name text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_column_idx ON cards (column_id, sort_key, id);
CREATE INDEX IF NOT EXISTS cards_board_idx ON cards (board_id);

CREATE TABLE IF NOT EXISTS card_votes (
  card_id  uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  voter_id text NOT NULL,
  PRIMARY KEY (card_id, voter_id)
);
