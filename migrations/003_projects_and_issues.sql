-- The tracker half of Pulseboard.
--
-- Anonymous boards (boards/columns/cards) stay exactly as they are: no account,
-- link is the room. Everything below needs a signed-in person, because "For
-- you", "Recent" and "Starred" are meaningless without one.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  is_demo       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The short prefix in an issue key: PAY-14. Upper case, letters and digits.
  key         text UNIQUE NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  lead_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Issue numbers are per project and must never be reused, so the project
  -- owns the counter rather than the app computing max()+1 and racing.
  issue_counter integer NOT NULL DEFAULT 0,
  is_demo     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS issues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       integer NOT NULL,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  type         text NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'bug', 'story')),
  status       text NOT NULL DEFAULT 'todo'
               CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done')),
  priority     text NOT NULL DEFAULT 'medium'
               CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  reporter_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Same fractional index and optimistic version guard as the retro cards, so
  -- dragging an issue between statuses has the same concurrency behaviour.
  sort_key     text COLLATE "C" NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE INDEX IF NOT EXISTS issues_board_idx ON issues (project_id, status, sort_key, id);
CREATE INDEX IF NOT EXISTS issues_assignee_idx ON issues (assignee_id) WHERE assignee_id IS NOT NULL;

-- Starred and recently-viewed are the two ways back to something you were
-- working on. Both point at either a project or an anonymous board.
CREATE TABLE IF NOT EXISTS stars (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('project', 'board')),
  entity_id   uuid NOT NULL,
  starred_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS recent_views (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('project', 'board', 'issue')),
  entity_id   uuid NOT NULL,
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS recent_views_idx ON recent_views (user_id, viewed_at DESC);
