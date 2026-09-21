import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { one, query } from './db.js';
import { AppError } from './errors.js';

const scrypt = promisify(crypto.scrypt) as (p: string, s: Buffer, k: number) => Promise<Buffer>;
const SESSION_DAYS = 30;

export interface User {
  id: string;
  email: string;
  name: string;
  isDemo: boolean;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

const USER_COLUMNS = 'id, email, name, is_demo';
interface UserRow { id: string; email: string; name: string; is_demo: boolean }
const toUser = (row: UserRow): User => ({ id: row.id, email: row.email, name: row.name, isDemo: row.is_demo });

export async function createUser(input: { email: string; password: string; name: string; isDemo?: boolean }): Promise<User> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim().slice(0, 80);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('INVALID', 'That email address does not look right.');
  if (input.password.length < 8) throw new AppError('INVALID', 'Use a password of at least 8 characters.');
  if (!name) throw new AppError('INVALID', 'Please give your name.');
  try {
    const row = await one<UserRow>(
      `INSERT INTO users (email, password_hash, name, is_demo) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLUMNS}`,
      [email, await hashPassword(input.password), name, input.isDemo ?? false],
    );
    return toUser(row!);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new AppError('CONFLICT', 'That email is already registered.');
    throw error;
  }
}

export async function authenticate(email: string, password: string): Promise<User | undefined> {
  const row = await one<UserRow & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = lower($1)`,
    [email.trim()],
  );
  if (!row || !(await verifyPassword(password, row.password_hash))) return undefined;
  return toUser(row);
}

export async function getUser(id: string): Promise<User | undefined> {
  const row = await one<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return row ? toUser(row) : undefined;
}

export async function getDemoUser(): Promise<User | undefined> {
  const row = await one<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE is_demo = true ORDER BY created_at LIMIT 1`);
  return row ? toUser(row) : undefined;
}

export async function createUserSession(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO user_sessions (token, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [token, userId, String(SESSION_DAYS)],
  );
  return token;
}

export async function userForSession(token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined;
  const row = await one<UserRow>(
    `SELECT u.id, u.email, u.name, u.is_demo
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
  return row ? toUser(row) : undefined;
}

export async function destroyUserSession(token: string | undefined): Promise<void> {
  if (token) await query('DELETE FROM user_sessions WHERE token = $1', [token]);
}
