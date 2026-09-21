import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUser, getDemoUser, type User } from './accounts.js';
import { createBoard, createCard, getBoardState, getDemoBoard, toggleVote, type Board } from './boards.js';
import { pool } from './db.js';
import {
  addMember,
  createIssue,
  createProject,
  getDemoProject,
  recordView,
  toggleStar,
  updateIssue,
  type IssuePriority,
  type IssueStatus,
  type IssueType,
} from './tracker.js';
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
    .then(seedDemoWorkspace)
    .then(() => pool.end())
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}


/* ------------------------------------------------------- demo workspace */

export const DEMO_EMAIL = 'demo@pulseboard.dev';
export const DEMO_PASSWORD = 'demo-password';

interface SeedIssue {
  title: string;
  type: IssueType;
  status: IssueStatus;
  priority: IssuePriority;
  /** Index into the teammate list, or null for unassigned. */
  assignee: number | null;
  description?: string;
}

const TEAM = [
  { email: 'marcus@pulseboard.dev', name: 'Marcus Webb' },
  { email: 'sofia@pulseboard.dev', name: 'Sofia Lindqvist' },
  { email: 'tomas@pulseboard.dev', name: 'Tomas Alvarez' },
];

const SEED_ISSUES: SeedIssue[] = [
  { title: 'Card declines show no error to the customer', type: 'bug', status: 'in_progress', priority: 'urgent', assignee: 0,
    description: 'A declined card silently returns to the form with no message. Reproduced with test card 4000000000000002.' },
  { title: 'Retry failed webhooks with exponential backoff', type: 'story', status: 'in_progress', priority: 'high', assignee: null,
    description: 'Three attempts, doubling from 2s. Give up after the third and record why.' },
  { title: 'Refunds page times out over 500 rows', type: 'bug', status: 'in_review', priority: 'high', assignee: 1,
    description: 'Missing index on refunds(created_at). Paginate as well.' },
  { title: 'Add Apple Pay to the checkout sheet', type: 'story', status: 'todo', priority: 'medium', assignee: 2 },
  { title: 'Move currency formatting into one helper', type: 'task', status: 'todo', priority: 'low', assignee: null,
    description: 'Four call sites format money slightly differently. One of them rounds.' },
  { title: 'Settlement report is off by one day for UTC+13', type: 'bug', status: 'todo', priority: 'high', assignee: 0 },
  { title: 'Document the payout schedule for support', type: 'task', status: 'done', priority: 'low', assignee: 1 },
  { title: 'Upgrade the payment SDK to v9', type: 'task', status: 'done', priority: 'medium', assignee: 2 },
  { title: 'Split the checkout form into steps', type: 'story', status: 'backlog', priority: 'medium', assignee: null },
  { title: 'Investigate duplicate charges reported on 14 Sept', type: 'bug', status: 'backlog', priority: 'urgent', assignee: null },
  { title: 'Add a sandbox mode toggle to settings', type: 'story', status: 'backlog', priority: 'low', assignee: null },
  { title: 'Delete the legacy /v1/charge endpoint', type: 'task', status: 'backlog', priority: 'low', assignee: 2 },
];

/**
 * A signed-in demo account with a project that already has a fortnight of work
 * in it, so "For you", "Recent", "Starred" and the dashboard all have something
 * to show the moment you land.
 */
export async function seedDemoWorkspace(): Promise<User> {
  const existing = await getDemoUser();
  if (existing) return existing;

  const demo = await createUser({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    name: 'Priya Raman',
    isDemo: true,
  });

  const team: User[] = [];
  for (const member of TEAM) {
    team.push(await createUser({ email: member.email, password: `${DEMO_PASSWORD}-${member.name}`, name: member.name }));
  }

  const payments = await createProject({
    key: 'PAY',
    name: 'Payments',
    description: 'Checkout, refunds, payouts and the webhook pipeline.',
    lead: demo,
    isDemo: true,
  });
  for (const member of team) await addMember(payments.id, member.id);

  // Reversed so the first entry above ends up at the top of its column.
  for (const seed of [...SEED_ISSUES].reverse()) {
    const created = await createIssue({
      project: payments,
      title: seed.title,
      description: seed.description ?? '',
      type: seed.type,
      priority: seed.priority,
      status: seed.status,
      assigneeId: seed.assignee === null ? null : team[seed.assignee]!.id,
      reporter: demo,
    });
    // A couple of issues are assigned to the demo account itself, so "For you"
    // is not empty on first load.
    if (seed.priority === 'urgent' && seed.status !== 'backlog') {
      await updateIssue({ issueId: created.id, patch: { assigneeId: demo.id } });
    }
  }

  const website = await createProject({
    key: 'WEB',
    name: 'Marketing site',
    description: 'Landing pages, pricing and the docs shell.',
    lead: demo,
  });
  await addMember(website.id, team[1]!.id);
  await createIssue({ project: website, title: 'Pricing page is unreadable on iPhone SE', type: 'bug',
    status: 'todo', priority: 'high', assigneeId: demo.id, reporter: demo });
  await createIssue({ project: website, title: 'Add a changelog page', type: 'story',
    status: 'backlog', priority: 'low', reporter: demo });

  await toggleStar(demo.id, 'project', payments.id);
  await recordView(demo.id, 'project', website.id);
  await recordView(demo.id, 'project', payments.id);

  const board = await getDemoBoard();
  if (board) {
    await toggleStar(demo.id, 'board', board.id);
    await recordView(demo.id, 'board', board.id);
  }

  console.log(`Seeded demo workspace: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  return demo;
}
