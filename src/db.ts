import pg from 'pg';
import { env } from './env.js';

// Postgres returns numerics as strings by default; card counts are plain ints so
// this keeps the wire format honest without surprising the callers.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/**
 * Every connection works inside one named schema.
 *
 * Managed Postgres plans are often limited to a single database (Render's free
 * tier allows exactly one), so several apps may have to share it. Giving each
 * one its own schema keeps their tables — and, importantly, their
 * `schema_migrations` bookkeeping — completely separate, without needing a
 * database each. `public` stays on the search path so shared extensions
 * installed there are still resolvable.
 */
export const schema = process.env.DB_SCHEMA?.trim() || 'public';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
  throw new Error(`DB_SCHEMA must be a plain lowercase identifier, got "${schema}"`);
}

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  ssl: env.databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  // Set in the startup packet rather than by a follow-up query, so there is no
  // window where a pooled connection is handed out on the wrong search path.
  options: schema === 'public' ? undefined : `-c search_path="${schema}",public`,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
