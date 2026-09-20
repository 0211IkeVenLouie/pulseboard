import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoard, createCard, getBoardState, getDemoBoard, toggleVote, type Board } from './boards.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';

const DEMO_SLUG = 'demo-retro';

const PEOPLE = [
  { id: 'demo-priya', name: 'Priya' },
  { id: 'demo-marcus', name: 'Marcus' },
  { id: 'demo-sofia', name: 'Sofia' },
  { id: 'demo-tomas', name: 'Tomas' },
];

const SEED_CARDS: Array<{ column: number; body: string; author: number; votes: number[] }> = [
  { column: 0, body: 'Deploys went from 20 minutes to 4 after the cache change.', author: 0, votes: [1, 2, 3] },
  { column: 0, body: 'Pairing on the migration caught two bugs before review.', author: 1, votes: [0, 2] },
  { column: 0, body: 'On-call was quiet for the first week all quarter.', author: 2, votes: [3] },
  { column: 1, body: 'Standup keeps running long — we are status-reporting, not unblocking.', author: 3, votes: [0, 1, 2] },
  { column: 1, body: 'Flaky checkout test failed 6 of 14 CI runs.', author: 0, votes: [1, 3] },
  { column: 1, body: 'Design handoff arrived mid-sprint again.', author: 2, votes: [] },
  { column: 2, body: 'Marcus to quarantine the flaky test and open a fix PR.', author: 1, votes: [0] },
  { column: 2, body: 'Try a 10-minute standup timer for two weeks.', author: 3, votes: [2] },
];

/**
 * A recruiter will not sign up. The demo board exists so the product is visible
 * five seconds after landing, with enough cards that the layout looks real.
 */
export async function seedDemoBoard(): Promise<Board> {
  const existing = await getDemoBoard();
  if (existing) return existing;

  const board = await createBoard({
    title: 'Sprint 24 retro — Payments squad',
    kind: 'retro',
    isDemo: true,
    slug: DEMO_SLUG,
  });
  const { columns } = await getBoardState(board, PEOPLE[0]!.id);

  // Inserted in reverse so the first entry above ends up at the top of its column.
  for (const card of [...SEED_CARDS].reverse()) {
    const author = PEOPLE[card.author]!;
    const created = await createCard({
      board,
      columnId: columns[card.column]!.id,
      body: card.body,
      authorId: author.id,
      authorName: author.name,
    });
    for (const voter of card.votes) {
      await toggleVote({ board, cardId: created.id, voterId: PEOPLE[voter]!.id });
    }
  }
  console.log(`Seeded demo board at /b/${board.slug}`);
  return board;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  migrate()
    .then(seedDemoBoard)
    .then(() => pool.end())
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
