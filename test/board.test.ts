import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { closeDatabase, resetDatabase } from './helpers.js';
import {
  createBoard,
  createCard,
  editCard,
  getBoardState,
  moveCard,
  setCardsHidden,
  toggleVote,
  type Board,
} from '../src/boards.js';
import { AppError } from '../src/errors.js';

const ALICE = { id: 'user-alice', name: 'Alice' };
const BOB = { id: 'user-bob', name: 'Bob' };

async function seedBoard(): Promise<{ board: Board; columnIds: string[] }> {
  const board = await createBoard({ title: 'Sprint 12', kind: 'retro' });
  const { columns } = await getBoardState(board, ALICE.id);
  return { board, columnIds: columns.map((c) => c.id) };
}

beforeEach(resetDatabase);
after(closeDatabase);

test('a new retro board comes with three columns and no cards', async () => {
  const { board, columnIds } = await seedBoard();
  const state = await getBoardState(board, ALICE.id);
  assert.equal(columnIds.length, 3);
  assert.deepEqual(state.columns.map((c) => c.title), ['Went well', 'To improve', 'Action items']);
  assert.equal(state.cards.length, 0);
});

test('cards are created at the top of their column', async () => {
  const { board, columnIds } = await seedBoard();
  const first = await createCard({ board, columnId: columnIds[0]!, body: 'first', ...author(ALICE) });
  const second = await createCard({ board, columnId: columnIds[0]!, body: 'second', ...author(ALICE) });
  const state = await getBoardState(board, ALICE.id);
  assert.deepEqual(state.cards.map((c) => c.id), [second.id, first.id]);
});

test('two people dropping different cards into the same gap both succeed', async () => {
  const { board, columnIds } = await seedBoard();
  const target = columnIds[1]!;
  const anchorTop = await createCard({ board, columnId: target, body: 'top', ...author(ALICE) });
  const anchorBottom = await createCard({ board, columnId: target, body: 'bottom', ...author(ALICE) });
  // anchorBottom was created last so it is on top; fix the intended order.
  await moveCard({
    board,
    cardId: anchorBottom.id,
    columnId: target,
    beforeId: anchorTop.id,
    afterId: null,
    baseVersion: anchorBottom.version,
    viewerId: ALICE.id,
  });

  const alicesCard = await createCard({ board, columnId: columnIds[0]!, body: 'from alice', ...author(ALICE) });
  const bobsCard = await createCard({ board, columnId: columnIds[2]!, body: 'from bob', ...author(BOB) });

  const [aliceResult, bobResult] = await Promise.all([
    moveCard({
      board,
      cardId: alicesCard.id,
      columnId: target,
      beforeId: anchorTop.id,
      afterId: anchorBottom.id,
      baseVersion: alicesCard.version,
      viewerId: ALICE.id,
    }),
    moveCard({
      board,
      cardId: bobsCard.id,
      columnId: target,
      beforeId: anchorTop.id,
      afterId: anchorBottom.id,
      baseVersion: bobsCard.version,
      viewerId: BOB.id,
    }),
  ]);

  assert.notEqual(aliceResult.card.sortKey, bobResult.card.sortKey, 'both drops minted the same key');
  const state = await getBoardState(board, ALICE.id);
  const inTarget = state.cards.filter((c) => c.columnId === target).map((c) => c.body);
  assert.equal(inTarget.length, 4);
  assert.equal(inTarget[0], 'top');
  assert.equal(inTarget[3], 'bottom');
  assert.deepEqual([...inTarget.slice(1, 3)].sort(), ['from alice', 'from bob']);
});

test('two people dragging the same card: the stale one is rejected with the authoritative card', async () => {
  const { board, columnIds } = await seedBoard();
  const card = await createCard({ board, columnId: columnIds[0]!, body: 'contested', ...author(ALICE) });

  const move = (columnId: string, viewerId: string) =>
    moveCard({
      board,
      cardId: card.id,
      columnId,
      beforeId: null,
      afterId: null,
      baseVersion: card.version,
      viewerId,
    });

  const results = await Promise.allSettled([move(columnIds[1]!, ALICE.id), move(columnIds[2]!, BOB.id)]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'exactly one move should win');
  assert.equal(rejected.length, 1, 'exactly one move should be rejected');

  const error = (rejected[0] as PromiseRejectedResult).reason as AppError;
  assert.equal(error.code, 'CONFLICT');
  const authoritative = error.details.card as { columnId: string; version: number };
  assert.equal(authoritative.version, card.version + 1, 'the loser is told the current version');

  const winner = (fulfilled[0] as PromiseFulfilledResult<{ card: { columnId: string } }>).value.card;
  assert.equal(authoritative.columnId, winner.columnId, 'the loser is told where the card actually is');

  const state = await getBoardState(board, ALICE.id);
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0]!.columnId, winner.columnId);
});

test('a drop whose neighbour vanished mid-drag still lands', async () => {
  const { board, columnIds } = await seedBoard();
  const target = columnIds[1]!;
  const anchor = await createCard({ board, columnId: target, body: 'anchor', ...author(ALICE) });
  const moving = await createCard({ board, columnId: columnIds[0]!, body: 'moving', ...author(BOB) });

  // Bob still thinks he is dropping below `anchor`, but Alice already moved it away.
  await moveCard({
    board,
    cardId: anchor.id,
    columnId: columnIds[2]!,
    beforeId: null,
    afterId: null,
    baseVersion: anchor.version,
    viewerId: ALICE.id,
  });

  const result = await moveCard({
    board,
    cardId: moving.id,
    columnId: target,
    beforeId: anchor.id,
    afterId: null,
    baseVersion: moving.version,
    viewerId: BOB.id,
  });
  assert.equal(result.card.columnId, target);
});

test('a stale edit is rejected and reports the newer text', async () => {
  const { board, columnIds } = await seedBoard();
  const card = await createCard({ board, columnId: columnIds[0]!, body: 'draft', ...author(ALICE) });
  await editCard({ board, cardId: card.id, body: 'alice wins', baseVersion: card.version, viewerId: ALICE.id });

  await assert.rejects(
    () => editCard({ board, cardId: card.id, body: 'bob is late', baseVersion: card.version, viewerId: BOB.id }),
    (error: AppError) => {
      assert.equal(error.code, 'CONFLICT');
      assert.equal((error.details.card as { body: string }).body, 'alice wins');
      return true;
    },
  );
});

test('votes toggle and are counted per voter', async () => {
  const { board, columnIds } = await seedBoard();
  const card = await createCard({ board, columnId: columnIds[0]!, body: 'ship it', ...author(ALICE) });

  await toggleVote({ board, cardId: card.id, voterId: ALICE.id });
  const afterBob = await toggleVote({ board, cardId: card.id, voterId: BOB.id });
  assert.equal(afterBob.votes, 2);
  assert.equal(afterBob.votedByMe, true);

  const afterUnvote = await toggleVote({ board, cardId: card.id, voterId: BOB.id });
  assert.equal(afterUnvote.votes, 1);
  assert.equal(afterUnvote.votedByMe, false);
});

test('hidden retro cards are masked server-side for everyone but the author', async () => {
  const { board, columnIds } = await seedBoard();
  await createCard({ board, columnId: columnIds[0]!, body: 'a candid opinion', ...author(ALICE) });
  const hidden = await setCardsHidden(board.id, true);

  const bobsView = await getBoardState(hidden, BOB.id);
  assert.equal(bobsView.cards[0]!.masked, true);
  assert.equal(bobsView.cards[0]!.body, '', 'masked bodies must not reach other clients');

  const alicesView = await getBoardState(hidden, ALICE.id);
  assert.equal(alicesView.cards[0]!.masked, false);
  assert.equal(alicesView.cards[0]!.body, 'a candid opinion');

  const revealed = await setCardsHidden(board.id, false);
  const afterReveal = await getBoardState(revealed, BOB.id);
  assert.equal(afterReveal.cards[0]!.body, 'a candid opinion');
});

function author(user: { id: string; name: string }) {
  return { authorId: user.id, authorName: user.name };
}
