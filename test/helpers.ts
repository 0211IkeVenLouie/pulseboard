// These suites share one database and truncate it between tests, so the test
// runner is pinned to one file at a time (--test-concurrency=1 in package.json).
// Running them in parallel has one suite wiping another's fixtures mid-test.
import { pool, query } from '../src/db.js';
import { migrate } from '../src/migrate.js';

let migrated = false;

export async function resetDatabase(): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
  await query(`TRUNCATE boards, columns, cards, card_votes,
    users, user_sessions, projects, project_members, issues, stars, recent_views
    RESTART IDENTITY CASCADE`);
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
