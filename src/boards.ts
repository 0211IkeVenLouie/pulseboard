import type { PoolClient } from 'pg';
import { one, query, transaction } from './db.js';
import { AppError } from './errors.js';
import { bySortKey, keyBetween, keysBetween } from './ordering.js';

export type BoardKind = 'retro' | 'kanban';

export interface Board {
  id: string;
  slug: string;
  title: string;
  kind: BoardKind;
  cardsHidden: boolean;
  isDemo: boolean;
}

export interface Column {
  id: string;
  boardId: string;
  title: string;
  sortKey: string;
}

export interface Card {
  id: string;
  boardId: string;
  columnId: string;
  body: string;
  sortKey: string;
  version: number;
  authorId: string;
  authorName: string;
  votes: number;
  votedByMe: boolean;
  masked: boolean;
}

export interface BoardState {
  board: Board;
  columns: Column[];
  cards: Card[];
}

const MAX_BODY = 500;
const RETRO_COLUMNS = ['Went well', 'To improve', 'Action items'];
const KANBAN_COLUMNS = ['Backlog', 'In progress', 'Review', 'Done'];

const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function randomSlug(length = 10): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SLUG_ALPHABET[Math.floor(Math.random() * SLUG_ALPHABET.length)];
  }
  return out;
}

interface BoardRow {
  id: string;
  slug: string;
  title: string;
  kind: BoardKind;
  cards_hidden: boolean;
  is_demo: boolean;
}

interface CardRow {
  id: string;
  board_id: string;
  column_id: string;
  body: string;
  sort_key: string;
  version: number;
  author_id: string;
  author_name: string;
  votes: number;
  voted_by_me: boolean;
}

function toBoard(row: BoardRow): Board {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    cardsHidden: row.cards_hidden,
    isDemo: row.is_demo,
  };
}

/**
 * Hidden retro cards are masked on the server, not in the browser -- otherwise
 * "hide until reveal" is one devtools inspection away from being useless.
 */
function toCard(row: CardRow, board: Board, viewerId: string): Card {
  const masked = board.cardsHidden && row.author_id !== viewerId;
  return {
    id: row.id,
    boardId: row.board_id,
    columnId: row.column_id,
    body: masked ? '' : row.body,
    sortKey: row.sort_key,
    version: row.version,
    authorId: row.author_id,
    authorName: masked ? 'Hidden' : row.author_name,
    votes: Number(row.votes),
    votedByMe: row.voted_by_me,
    masked,
  };
}

const CARD_SELECT = `
  SELECT c.id, c.board_id, c.column_id, c.body, c.sort_key, c.version,
         c.author_id, c.author_name,
         COALESCE(v.count, 0)::int AS votes,
         (mine.voter_id IS NOT NULL) AS voted_by_me
    FROM cards c
    LEFT JOIN (SELECT card_id, COUNT(*)::int AS count FROM card_votes GROUP BY card_id) v
           ON v.card_id = c.id
    LEFT JOIN card_votes mine ON mine.card_id = c.id AND mine.voter_id = $2
`;

export async function createBoard(input: {
  title: string;
  kind: BoardKind;
  isDemo?: boolean;
  slug?: string;
}): Promise<Board> {
  const title = input.title.trim().slice(0, 120) || 'Untitled board';
  const titles = input.kind === 'retro' ? RETRO_COLUMNS : KANBAN_COLUMNS;

  return transaction(async (client) => {
    const boardRow = (
      await client.query<BoardRow>(
        `INSERT INTO boards (slug, title, kind, is_demo)
         VALUES ($1, $2, $3, $4)
         RETURNING id, slug, title, kind, cards_hidden, is_demo`,
        [input.slug ?? randomSlug(), title, input.kind, input.isDemo ?? false],
      )
    ).rows[0]!;

    const keys = keysBetween(null, null, titles.length);
    for (const [index, columnTitle] of titles.entries()) {
      await client.query('INSERT INTO columns (board_id, title, sort_key) VALUES ($1, $2, $3)', [
        boardRow.id,
        columnTitle,
        keys[index]!,
      ]);
    }
    return toBoard(boardRow);
  });
}

export async function getBoardBySlug(slug: string): Promise<Board | undefined> {
  const row = await one<BoardRow>(
    'SELECT id, slug, title, kind, cards_hidden, is_demo FROM boards WHERE slug = $1',
    [slug],
  );
  return row ? toBoard(row) : undefined;
}

export async function getDemoBoard(): Promise<Board | undefined> {
  const row = await one<BoardRow>(
    'SELECT id, slug, title, kind, cards_hidden, is_demo FROM boards WHERE is_demo = true ORDER BY created_at LIMIT 1',
  );
  return row ? toBoard(row) : undefined;
}

export async function getBoardState(board: Board, viewerId: string): Promise<BoardState> {
  const [columnRows, cardRows] = await Promise.all([
    query<{ id: string; board_id: string; title: string; sort_key: string }>(
      'SELECT id, board_id, title, sort_key FROM columns WHERE board_id = $1',
      [board.id],
    ),
    query<CardRow>(`${CARD_SELECT} WHERE c.board_id = $1`, [board.id, viewerId]),
  ]);

  const columns = columnRows
    .map((row) => ({ id: row.id, boardId: row.board_id, title: row.title, sortKey: row.sort_key }))
    .sort(bySortKey);
  const cards = cardRows.map((row) => toCard(row, board, viewerId)).sort(bySortKey);
  return { board, columns, cards };
}

async function readCard(client: PoolClient, cardId: string, viewerId: string): Promise<CardRow> {
  const row = (await client.query<CardRow>(`${CARD_SELECT} WHERE c.id = $1`, [cardId, viewerId])).rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'That card no longer exists.', { cardId });
  return row;
}

export async function createCard(input: {
  board: Board;
  columnId: string;
  body: string;
  authorId: string;
  authorName: string;
}): Promise<Card> {
  const body = input.body.trim().slice(0, MAX_BODY);
  if (!body) throw new AppError('INVALID', 'A card needs some text.');

  return transaction(async (client) => {
    const column = (
      await client.query<{ id: string }>(
        'SELECT id FROM columns WHERE id = $1 AND board_id = $2 FOR UPDATE',
        [input.columnId, input.board.id],
      )
    ).rows[0];
    if (!column) throw new AppError('NOT_FOUND', 'That column no longer exists.');

    // New cards land on top, which is where people look after typing one.
    const head = (
      await client.query<{ sort_key: string }>(
        'SELECT sort_key FROM cards WHERE column_id = $1 ORDER BY sort_key, id LIMIT 1',
        [input.columnId],
      )
    ).rows[0];

    const inserted = (
      await client.query<{ id: string }>(
        `INSERT INTO cards (board_id, column_id, body, sort_key, author_id, author_name)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          input.board.id,
          input.columnId,
          body,
          keyBetween(null, head?.sort_key ?? null),
          input.authorId,
          input.authorName,
        ],
      )
    ).rows[0]!;

    return toCard(await readCard(client, inserted.id, input.authorId), input.board, input.authorId);
  });
}

export interface MoveResult {
  card: Card;
}

/**
 * Move a card, guarded by the version the dragging client had when it picked
 * the card up.
 *
 * Two clients dragging *different* cards into the same gap both succeed: the
 * server recomputes the key from the neighbours it sees under a row lock, so
 * they get distinct keys. Two clients dragging the *same* card is a genuine
 * conflict -- the second one arrives with a stale version and is rejected with
 * the authoritative card, so its optimistic UI snaps back rather than
 * resurrecting a position the other person already moved away from.
 */
export async function moveCard(input: {
  board: Board;
  cardId: string;
  columnId: string;
  beforeId: string | null;
  afterId: string | null;
  baseVersion: number;
  viewerId: string;
}): Promise<MoveResult> {
  return transaction(async (client) => {
    const current = (
      await client.query<{ id: string; version: number; board_id: string }>(
        'SELECT id, version, board_id FROM cards WHERE id = $1 FOR UPDATE',
        [input.cardId],
      )
    ).rows[0];
    if (!current || current.board_id !== input.board.id) {
      throw new AppError('NOT_FOUND', 'That card no longer exists.', { cardId: input.cardId });
    }
    if (current.version !== input.baseVersion) {
      const authoritative = toCard(
        await readCard(client, input.cardId, input.viewerId),
        input.board,
        input.viewerId,
      );
      throw new AppError('CONFLICT', 'Someone else moved that card first.', { card: authoritative });
    }

    // Lock the destination column for the rest of the transaction. Without it
    // two people dropping *different* cards into the same gap read the same
    // neighbours and mint the same key: legal (the id tie-break keeps every
    // client in the same order) but it wastes the gap. Serialising the handful
    // of milliseconds it takes to compute one key is the cheaper trade.
    const column = (
      await client.query<{ id: string }>(
        'SELECT id FROM columns WHERE id = $1 AND board_id = $2 FOR UPDATE',
        [input.columnId, input.board.id],
      )
    ).rows[0];
    if (!column) throw new AppError('NOT_FOUND', 'That column no longer exists.');

    // The neighbours are re-read here rather than trusted from the client: the
    // browser's idea of "drop after card X" can be stale by the time it lands.
    const anchors = (
      await client.query<{ id: string; sort_key: string }>(
        'SELECT id, sort_key FROM cards WHERE column_id = $1 AND id <> $2 AND id = ANY($3::uuid[])',
        [input.columnId, input.cardId, [input.beforeId, input.afterId].filter(Boolean)],
      )
    ).rows;
    const anchorKey = (id: string | null) =>
      id === null ? null : (anchors.find((row) => row.id === id)?.sort_key ?? null);

    // Only ONE anchor is trusted, and the opposite bound is whatever card is
    // adjacent to it right now. Taking both bounds from the client is what lets
    // two people who asked for "between A and B" mint the same key: by the time
    // the second drop is applied, the first card is already sitting in that gap
    // and has to be treated as the new bound.
    const boundAbove = async (key: string) =>
      (
        await client.query<{ sort_key: string }>(
          `SELECT sort_key FROM cards
            WHERE column_id = $1 AND id <> $2 AND sort_key > $3
            ORDER BY sort_key LIMIT 1`,
          [input.columnId, input.cardId, key],
        )
      ).rows[0]?.sort_key ?? null;
    const boundBelow = async (key: string) =>
      (
        await client.query<{ sort_key: string }>(
          `SELECT sort_key FROM cards
            WHERE column_id = $1 AND id <> $2 AND sort_key < $3
            ORDER BY sort_key DESC LIMIT 1`,
          [input.columnId, input.cardId, key],
        )
      ).rows[0]?.sort_key ?? null;
    const edgeKey = async (end: 'head' | 'tail') =>
      (
        await client.query<{ sort_key: string }>(
          `SELECT sort_key FROM cards WHERE column_id = $1 AND id <> $2
            ORDER BY sort_key ${end === 'head' ? 'ASC' : 'DESC'} LIMIT 1`,
          [input.columnId, input.cardId],
        )
      ).rows[0]?.sort_key ?? null;

    const above = anchorKey(input.beforeId);
    const below = anchorKey(input.afterId);
    let beforeKey: string | null;
    let afterKey: string | null;

    if (above !== null) {
      beforeKey = above;
      afterKey = await boundAbove(above);
    } else if (below !== null) {
      afterKey = below;
      beforeKey = await boundBelow(below);
    } else if (input.beforeId !== null) {
      // The card it was dropped under has been moved away or deleted mid-drag.
      // Landing at the bottom of the column beats rejecting the drop.
      beforeKey = await edgeKey('tail');
      afterKey = null;
    } else {
      beforeKey = null;
      afterKey = await edgeKey('head');
    }

    await client.query(
      `UPDATE cards
          SET column_id = $2, sort_key = $3, version = version + 1, updated_at = now()
        WHERE id = $1`,
      [input.cardId, input.columnId, keyBetween(beforeKey, afterKey)],
    );

    return {
      card: toCard(await readCard(client, input.cardId, input.viewerId), input.board, input.viewerId),
    };
  });
}

export async function editCard(input: {
  board: Board;
  cardId: string;
  body: string;
  baseVersion: number;
  viewerId: string;
}): Promise<Card> {
  const body = input.body.trim().slice(0, MAX_BODY);
  if (!body) throw new AppError('INVALID', 'A card needs some text.');

  return transaction(async (client) => {
    const current = (
      await client.query<{ version: number; board_id: string }>(
        'SELECT version, board_id FROM cards WHERE id = $1 FOR UPDATE',
        [input.cardId],
      )
    ).rows[0];
    if (!current || current.board_id !== input.board.id) {
      throw new AppError('NOT_FOUND', 'That card no longer exists.', { cardId: input.cardId });
    }
    if (current.version !== input.baseVersion) {
      const authoritative = toCard(
        await readCard(client, input.cardId, input.viewerId),
        input.board,
        input.viewerId,
      );
      throw new AppError('CONFLICT', 'Someone else edited that card while you were typing.', {
        card: authoritative,
      });
    }
    await client.query(
      'UPDATE cards SET body = $2, version = version + 1, updated_at = now() WHERE id = $1',
      [input.cardId, body],
    );
    return toCard(await readCard(client, input.cardId, input.viewerId), input.board, input.viewerId);
  });
}

export async function deleteCard(input: { board: Board; cardId: string }): Promise<void> {
  const deleted = await query('DELETE FROM cards WHERE id = $1 AND board_id = $2 RETURNING id', [
    input.cardId,
    input.board.id,
  ]);
  if (deleted.length === 0) throw new AppError('NOT_FOUND', 'That card no longer exists.');
}

/**
 * Voting is commutative, so unlike a move it needs no version guard -- two
 * people voting at the same instant is not a conflict, it is two votes.
 */
export async function toggleVote(input: {
  board: Board;
  cardId: string;
  voterId: string;
}): Promise<Card> {
  return transaction(async (client) => {
    const exists = (
      await client.query('SELECT 1 FROM cards WHERE id = $1 AND board_id = $2', [
        input.cardId,
        input.board.id,
      ])
    ).rowCount;
    if (!exists) throw new AppError('NOT_FOUND', 'That card no longer exists.');

    const removed = await client.query('DELETE FROM card_votes WHERE card_id = $1 AND voter_id = $2', [
      input.cardId,
      input.voterId,
    ]);
    if (removed.rowCount === 0) {
      await client.query(
        'INSERT INTO card_votes (card_id, voter_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [input.cardId, input.voterId],
      );
    }
    return toCard(await readCard(client, input.cardId, input.voterId), input.board, input.voterId);
  });
}

export async function setCardsHidden(boardId: string, hidden: boolean): Promise<Board> {
  const row = await one<BoardRow>(
    `UPDATE boards SET cards_hidden = $2 WHERE id = $1
     RETURNING id, slug, title, kind, cards_hidden, is_demo`,
    [boardId, hidden],
  );
  if (!row) throw new AppError('NOT_FOUND', 'That board no longer exists.');
  return toBoard(row);
}

export async function renameColumn(board: Board, columnId: string, title: string): Promise<Column> {
  const trimmed = title.trim().slice(0, 60);
  if (!trimmed) throw new AppError('INVALID', 'A column needs a name.');
  const row = await one<{ id: string; board_id: string; title: string; sort_key: string }>(
    'UPDATE columns SET title = $3 WHERE id = $1 AND board_id = $2 RETURNING id, board_id, title, sort_key',
    [columnId, board.id, trimmed],
  );
  if (!row) throw new AppError('NOT_FOUND', 'That column no longer exists.');
  return { id: row.id, boardId: row.board_id, title: row.title, sortKey: row.sort_key };
}

export async function renameBoard(boardId: string, title: string): Promise<Board> {
  const trimmed = title.trim().slice(0, 120);
  if (!trimmed) throw new AppError('INVALID', 'The board needs a name.');
  const row = await one<BoardRow>(
    `UPDATE boards SET title = $2 WHERE id = $1
     RETURNING id, slug, title, kind, cards_hidden, is_demo`,
    [boardId, trimmed],
  );
  if (!row) throw new AppError('NOT_FOUND', 'That board no longer exists.');
  return toBoard(row);
}

export async function deleteColumn(board: Board, columnId: string): Promise<void> {
  const remaining = await query<{ id: string }>('SELECT id FROM columns WHERE board_id = $1', [board.id]);
  if (remaining.length <= 1) {
    throw new AppError('INVALID', 'A board needs at least one column.');
  }
  const deleted = await query('DELETE FROM columns WHERE id = $1 AND board_id = $2 RETURNING id', [
    columnId,
    board.id,
  ]);
  if (deleted.length === 0) throw new AppError('NOT_FOUND', 'That column no longer exists.');
}

export async function addColumn(board: Board, title: string): Promise<Column> {
  const tail = await one<{ sort_key: string }>(
    'SELECT sort_key FROM columns WHERE board_id = $1 ORDER BY sort_key DESC LIMIT 1',
    [board.id],
  );
  const row = await one<{ id: string; board_id: string; title: string; sort_key: string }>(
    'INSERT INTO columns (board_id, title, sort_key) VALUES ($1, $2, $3) RETURNING id, board_id, title, sort_key',
    [board.id, title.trim().slice(0, 60) || 'New column', keyBetween(tail?.sort_key ?? null, null)],
  );
  return { id: row!.id, boardId: row!.board_id, title: row!.title, sortKey: row!.sort_key };
}
