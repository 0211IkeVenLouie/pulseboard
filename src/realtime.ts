import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  addColumn,
  createCard,
  deleteCard,
  editCard,
  getBoardBySlug,
  getBoardState,
  moveCard,
  setCardsHidden,
  toggleVote,
  type Board,
} from './boards.js';
import { AppError } from './errors.js';
import { normaliseIdentity, type Identity } from './identity.js';

interface Member extends Identity {
  socketId: string;
}

/** Presence is deliberately in-memory: it is worthless a second after you leave. */
const presence = new Map<string, Map<string, Member>>();

function roomMembers(slug: string): Member[] {
  return [...(presence.get(slug)?.values() ?? [])];
}

type Ack = (response: unknown) => void;

function ok(ack: Ack | undefined, payload: Record<string, unknown> = {}): void {
  ack?.({ ok: true, ...payload });
}

function fail(ack: Ack | undefined, error: unknown): void {
  if (error instanceof AppError) {
    ack?.({ ok: false, code: error.code, message: error.message, ...error.details });
    return;
  }
  console.error('socket handler failed', error);
  ack?.({ ok: false, code: 'INTERNAL', message: 'Something went wrong. Refresh to resync.' });
}

/** A crude token bucket: enough to stop a stuck client hammering the database. */
function makeLimiter(capacity: number, refillPerSecond: number) {
  let tokens = capacity;
  let last = Date.now();
  return function take(): boolean {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

interface SocketSession {
  identity: Identity;
  board: Board;
}

export function attachRealtime(httpServer: HttpServer): Server {
  const io = new Server(httpServer, { serveClient: true, cors: { origin: false } });

  io.on('connection', (socket: Socket) => {
    const identity = normaliseIdentity(socket.handshake.auth);
    const takeToken = makeLimiter(40, 8);
    let session: SocketSession | undefined;

    socket.on('join', async (payload: { slug?: string }, ack?: Ack) => {
      try {
        const board = await getBoardBySlug(String(payload?.slug ?? ''));
        if (!board) throw new AppError('NOT_FOUND', 'That board does not exist.');

        session = { identity, board };
        await socket.join(board.slug);

        const members = presence.get(board.slug) ?? new Map<string, Member>();
        members.set(socket.id, { ...identity, socketId: socket.id });
        presence.set(board.slug, members);

        const state = await getBoardState(board, identity.id);
        ok(ack, { you: identity, ...state, members: roomMembers(board.slug) });
        io.to(board.slug).emit('presence', { members: roomMembers(board.slug) });
      } catch (error) {
        fail(ack, error);
      }
    });

    /** Every mutating handler shares the same shape: authorise, apply, broadcast. */
    function handler<T>(
      event: string,
      apply: (session: SocketSession, payload: T) => Promise<{ ack: Record<string, unknown>; broadcast?: [string, unknown] }>,
    ): void {
      socket.on(event, async (payload: T, ack?: Ack) => {
        try {
          if (!session) throw new AppError('FORBIDDEN', 'Join a board first.');
          if (!takeToken()) throw new AppError('INVALID', 'Slow down a moment.');
          // The board row is re-read so a reveal toggle by someone else is
          // reflected in the masking of whatever this op returns.
          const board = (await getBoardBySlug(session.board.slug)) ?? session.board;
          session = { ...session, board };
          const result = await apply(session, payload);
          ok(ack, result.ack);
          if (result.broadcast) {
            socket.to(board.slug).emit(result.broadcast[0], result.broadcast[1]);
          }
        } catch (error) {
          fail(ack, error);
        }
      });
    }

    handler<{ columnId: string; body: string }>('card:create', async (s, payload) => {
      const card = await createCard({
        board: s.board,
        columnId: String(payload?.columnId ?? ''),
        body: String(payload?.body ?? ''),
        authorId: s.identity.id,
        authorName: s.identity.name,
      });
      // Other clients get the masked view; the author gets their own text back.
      const forOthers = s.board.cardsHidden ? { ...card, body: '', authorName: 'Hidden', masked: true } : card;
      return { ack: { card }, broadcast: ['card:created', { card: forOthers }] };
    });

    handler<{ cardId: string; columnId: string; beforeId: string | null; afterId: string | null; baseVersion: number }>(
      'card:move',
      async (s, payload) => {
        const { card } = await moveCard({
          board: s.board,
          cardId: String(payload?.cardId ?? ''),
          columnId: String(payload?.columnId ?? ''),
          beforeId: payload?.beforeId ?? null,
          afterId: payload?.afterId ?? null,
          baseVersion: Number(payload?.baseVersion ?? -1),
          viewerId: s.identity.id,
        });
        const forOthers = s.board.cardsHidden && card.authorId !== s.identity.id
          ? card
          : { ...card, body: s.board.cardsHidden ? '' : card.body };
        return {
          ack: { card },
          broadcast: ['card:updated', { card: s.board.cardsHidden ? forOthers : card, movedBy: s.identity }],
        };
      },
    );

    handler<{ cardId: string; body: string; baseVersion: number }>('card:edit', async (s, payload) => {
      const card = await editCard({
        board: s.board,
        cardId: String(payload?.cardId ?? ''),
        body: String(payload?.body ?? ''),
        baseVersion: Number(payload?.baseVersion ?? -1),
        viewerId: s.identity.id,
      });
      const forOthers = s.board.cardsHidden ? { ...card, body: '', authorName: 'Hidden', masked: true } : card;
      return { ack: { card }, broadcast: ['card:updated', { card: forOthers }] };
    });

    handler<{ cardId: string }>('card:delete', async (s, payload) => {
      const cardId = String(payload?.cardId ?? '');
      await deleteCard({ board: s.board, cardId });
      return { ack: { cardId }, broadcast: ['card:deleted', { cardId }] };
    });

    handler<{ cardId: string }>('card:vote', async (s, payload) => {
      const card = await toggleVote({
        board: s.board,
        cardId: String(payload?.cardId ?? ''),
        voterId: s.identity.id,
      });
      // Vote counts are shared, but "did I vote" is per viewer, so the
      // broadcast deliberately drops this socket's votedByMe flag.
      return {
        ack: { card },
        broadcast: ['card:votes', { cardId: card.id, votes: card.votes }],
      };
    });

    handler<{ hidden: boolean }>('board:hidden', async (s, payload) => {
      const board = await setCardsHidden(s.board.id, Boolean(payload?.hidden));
      return { ack: { board }, broadcast: ['board:updated', { board, resync: true }] };
    });

    handler<{ title: string }>('column:add', async (s, payload) => {
      const column = await addColumn(s.board, String(payload?.title ?? ''));
      return { ack: { column }, broadcast: ['column:created', { column }] };
    });

    // Cursors are fire-and-forget: no ack, no persistence, no rate limit beyond
    // the client-side throttle. A dropped cursor frame does not matter.
    socket.on('cursor', (payload: { x?: number; y?: number }) => {
      if (!session) return;
      const x = Number(payload?.x);
      const y = Number(payload?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      socket.to(session.board.slug).emit('cursor', {
        id: identity.id,
        name: identity.name,
        color: identity.color,
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
      });
    });

    socket.on('disconnect', () => {
      if (!session) return;
      const members = presence.get(session.board.slug);
      members?.delete(socket.id);
      if (members && members.size === 0) presence.delete(session.board.slug);
      io.to(session.board.slug).emit('presence', { members: roomMembers(session.board.slug) });
      socket.to(session.board.slug).emit('cursor:gone', { id: identity.id });
    });
  });

  return io;
}
