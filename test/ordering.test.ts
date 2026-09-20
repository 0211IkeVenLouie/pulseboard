import assert from 'node:assert/strict';
import test from 'node:test';
import { bySortKey, isValidKey, keyBetween, keysBetween } from '../src/ordering.js';

test('appends to an empty list', () => {
  const key = keyBetween(null, null);
  assert.ok(isValidKey(key));
});

test('a key between two keys sorts between them', () => {
  const a = keyBetween(null, null);
  const b = keyBetween(a, null);
  const middle = keyBetween(a, b);
  assert.ok(a < middle && middle < b, `${a} < ${middle} < ${b}`);
});

test('keys stay valid when repeatedly splitting the same gap', () => {
  let low = keyBetween(null, null);
  const high = keyBetween(low, null);
  for (let i = 0; i < 200; i += 1) {
    const next = keyBetween(low, high);
    assert.ok(isValidKey(next), `invalid key ${next}`);
    assert.ok(low < next && next < high, `${low} < ${next} < ${high} failed at iteration ${i}`);
    low = next;
  }
});

test('prepending 500 times keeps strict ordering', () => {
  let head = keyBetween(null, null);
  const keys = [head];
  for (let i = 0; i < 500; i += 1) {
    head = keyBetween(null, head);
    assert.ok(isValidKey(head));
    keys.unshift(head);
  }
  for (let i = 1; i < keys.length; i += 1) {
    assert.ok(keys[i - 1]! < keys[i]!, `order broke at ${i}`);
  }
});

test('random interleaved inserts never break the ordering invariant', () => {
  const list: string[] = [keyBetween(null, null)];
  for (let i = 0; i < 400; i += 1) {
    const index = Math.floor(Math.random() * (list.length + 1));
    const before = index === 0 ? null : list[index - 1]!;
    const after = index === list.length ? null : list[index]!;
    const key = keyBetween(before, after);
    assert.ok(isValidKey(key), `invalid key ${key}`);
    list.splice(index, 0, key);
  }
  const sorted = [...list].sort();
  assert.deepEqual(list, sorted, 'insertion order diverged from lexicographic order');
  assert.equal(new Set(list).size, list.length, 'duplicate keys minted');
});

test('keysBetween produces the requested number of ascending keys', () => {
  const keys = keysBetween(null, null, 7);
  assert.equal(keys.length, 7);
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(keys.every(isValidKey));
});

test('rejects reversed bounds', () => {
  const a = keyBetween(null, null);
  const b = keyBetween(a, null);
  assert.throws(() => keyBetween(b, a), /out of order/);
});

test('bySortKey falls back to id for identical keys', () => {
  const rows = [
    { id: 'b', sortKey: 'V' },
    { id: 'a', sortKey: 'V' },
    { id: 'c', sortKey: 'A' },
  ];
  assert.deepEqual(rows.sort(bySortKey).map((r) => r.id), ['c', 'a', 'b']);
});
