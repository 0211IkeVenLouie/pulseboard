/**
 * Fractional indexing.
 *
 * Cards are ordered by a string key compared lexicographically. Inserting
 * between two cards mints a brand new key strictly between their keys, so a
 * move writes exactly one row and never renumbers its neighbours. Two people
 * dropping different cards into the same gap at the same time therefore both
 * succeed with distinct keys, instead of racing over a shared integer column.
 *
 * Port of the well-known base-62 midpoint algorithm, with the invariant that a
 * key is never empty and never ends in the lowest digit ('0') -- that keeps an
 * unbounded supply of keys available below any existing key.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

export const FIRST_KEY = 'V';

export function isValidKey(key: string): boolean {
  if (key.length === 0) return false;
  if (key.endsWith('0')) return false;
  return [...key].every((char) => DIGITS.includes(char));
}

function digitAt(key: string, index: number): number {
  const char = key[index];
  return char === undefined ? 0 : DIGITS.indexOf(char);
}

/**
 * Smallest-ish key strictly between `a` and `b`.
 * `a` may be '' (meaning "before everything") and `b` may be null ("after everything").
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new Error(`midpoint: ${a} is not before ${b}`);
  }
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) {
    throw new Error('midpoint: keys must not end with the lowest digit');
  }

  if (b !== null) {
    // Skip the shared prefix, then solve the smaller problem.
    // `a` is conceptually padded with infinite trailing zeros, otherwise
    // midpoint('', '0V') would walk past the shared '0' and mint the invalid
    // key '0'.
    let shared = 0;
    while ((a[shared] ?? '0') === b[shared]) shared += 1;
    if (shared > 0) {
      return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
    }
  }

  const digitA = a.length > 0 ? digitAt(a, 0) : 0;
  const digitB = b !== null ? digitAt(b, 0) : BASE;

  if (digitB - digitA > 1) {
    const middle = Math.round(0.5 * (digitA + digitB));
    return DIGITS[middle]!;
  }
  // The first digits are adjacent: keep b's first digit and recurse deeper,
  // or descend into a's tail when there is no room above.
  if (b !== null && b.length > 1) {
    return b.slice(0, 1);
  }
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

/**
 * A key that sorts strictly between `before` and `after`.
 * Pass null for either side to append to the head or the tail of a list.
 */
export function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && !isValidKey(before)) throw new Error(`Invalid sort key: ${before}`);
  if (after !== null && !isValidKey(after)) throw new Error(`Invalid sort key: ${after}`);
  if (before !== null && after !== null && before >= after) {
    throw new Error(`Sort keys out of order: ${before} >= ${after}`);
  }
  if (before === null && after === null) return FIRST_KEY;
  return midpoint(before ?? '', after);
}

/** `count` evenly spread keys between the two bounds, in ascending order. */
export function keysBetween(before: string | null, after: string | null, count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return [keyBetween(before, after)];
  const middle = keyBetween(before, after);
  const half = Math.floor(count / 2);
  return [
    ...keysBetween(before, middle, half),
    middle,
    ...keysBetween(middle, after, count - half - 1),
  ];
}

/**
 * Sorting used everywhere a list of keyed rows is rendered. The id is the
 * tie-break so that a (theoretically impossible) duplicate key still produces
 * the same order on every client.
 */
export function bySortKey<T extends { sortKey: string; id: string }>(a: T, b: T): number {
  if (a.sortKey === b.sortKey) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.sortKey < b.sortKey ? -1 : 1;
}
