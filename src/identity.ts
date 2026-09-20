import crypto from 'node:crypto';

const ADJECTIVES = ['Amber', 'Brisk', 'Calm', 'Dapper', 'Eager', 'Fleet', 'Glad', 'Keen', 'Lucid', 'Nimble', 'Quiet', 'Swift'];
const ANIMALS = ['Otter', 'Falcon', 'Heron', 'Lynx', 'Marlin', 'Ibex', 'Puffin', 'Raven', 'Tapir', 'Vole', 'Wren', 'Yak'];

export interface Identity {
  id: string;
  name: string;
  color: string;
}

export function randomName(): string {
  const adjective = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)]!;
  const animal = ANIMALS[crypto.randomInt(ANIMALS.length)]!;
  return `${adjective} ${animal}`;
}

/** Stable per-person colour so a cursor keeps its identity across reconnects. */
export function colorFor(id: string): string {
  const digest = crypto.createHash('sha256').update(id).digest();
  const hue = ((digest[0]! << 8) | digest[1]!) % 360;
  return `hsl(${hue} 68% 45%)`;
}

export function normaliseIdentity(raw: unknown): Identity {
  const input = (raw ?? {}) as { id?: unknown; name?: unknown };
  const id = typeof input.id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(input.id)
    ? input.id
    : crypto.randomUUID();
  const name = typeof input.name === 'string' && input.name.trim().length > 0
    ? input.name.trim().slice(0, 32)
    : randomName();
  return { id, name, color: colorFor(id) };
}
