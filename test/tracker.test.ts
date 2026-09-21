import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { closeDatabase, resetDatabase } from './helpers.js';
import { authenticate, createUser, type User } from '../src/accounts.js';
import { createBoard } from '../src/boards.js';
import { safeReturnTo } from '../src/tracker-routes.js';
import { AppError } from '../src/errors.js';
import {
  createIssue,
  createProject,
  getIssue,
  listAssignedTo,
  listIssues,
  listProjectsFor,
  listRecent,
  listStarred,
  moveIssue,
  projectStats,
  recordView,
  toggleStar,
  updateIssue,
  type Project,
} from '../src/tracker.js';

async function seed(): Promise<{ lead: User; dev: User; project: Project }> {
  const lead = await createUser({ email: 'lead@example.com', password: 'correct horse', name: 'Priya Raman' });
  const dev = await createUser({ email: 'dev@example.com', password: 'correct horse', name: 'Marcus Webb' });
  const project = await createProject({ key: 'pay', name: 'Payments', lead });
  return { lead, dev, project };
}

beforeEach(resetDatabase);
after(closeDatabase);

test('a project takes an upper-case key and enrols its lead', async () => {
  const { lead, project } = await seed();
  assert.equal(project.key, 'PAY', 'keys are normalised to upper case');
  const mine = await listProjectsFor(lead.id);
  assert.deepEqual(mine.map((p) => p.key), ['PAY']);
  assert.equal(mine[0]!.issueCount, 0);
});

test('project keys are validated and unique', async () => {
  const { lead } = await seed();
  await assert.rejects(() => createProject({ key: 'P', name: 'Too short', lead }), /2–10 letters/);
  await assert.rejects(() => createProject({ key: '1PAY', name: 'Starts with a digit', lead }), /2–10 letters/);
  await assert.rejects(
    () => createProject({ key: 'PAY', name: 'Duplicate', lead }),
    (error: AppError) => error.code === 'CONFLICT' && /taken/.test(error.message),
  );
});

test('issues are numbered per project and never reuse a number', async () => {
  const { lead, project } = await seed();
  const first = await createIssue({ project, title: 'Card declines are silent', reporter: lead });
  const second = await createIssue({ project, title: 'Add retry backoff', reporter: lead });
  assert.equal(first.key, 'PAY-1');
  assert.equal(second.key, 'PAY-2');

  const other = await createProject({ key: 'WEB', name: 'Website', lead });
  const elsewhere = await createIssue({ project: other, title: 'Fix the footer', reporter: lead });
  assert.equal(elsewhere.key, 'WEB-1', 'numbering is per project');
});

test('two people filing at the same instant get different numbers', async () => {
  const { lead, project } = await seed();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => createIssue({ project, title: `Issue ${i}`, reporter: lead })),
  );
  const numbers = results.map((issue) => issue.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8], 'no duplicates, no gaps');
});

test('an issue can be edited field by field', async () => {
  const { lead, dev, project } = await seed();
  const issue = await createIssue({ project, title: 'Card declines are silent', reporter: lead });

  const updated = await updateIssue({
    issueId: issue.id,
    patch: { type: 'bug', priority: 'urgent', assigneeId: dev.id, description: 'No error shown to the user.' },
  });
  assert.equal(updated.type, 'bug');
  assert.equal(updated.priority, 'urgent');
  assert.equal(updated.assigneeName, 'Marcus Webb');
  assert.equal(updated.version, issue.version + 1);

  // Unspecified fields are left alone.
  const renamed = await updateIssue({ issueId: issue.id, patch: { title: 'Card declines show no error' } });
  assert.equal(renamed.priority, 'urgent');
  assert.equal(renamed.assigneeId, dev.id);
});

test('a stale edit is rejected with the current issue', async () => {
  const { lead, project } = await seed();
  const issue = await createIssue({ project, title: 'Contested', reporter: lead });
  await updateIssue({ issueId: issue.id, patch: { title: 'Won' }, baseVersion: issue.version });

  await assert.rejects(
    () => updateIssue({ issueId: issue.id, patch: { title: 'Lost' }, baseVersion: issue.version }),
    (error: AppError) => {
      assert.equal(error.code, 'CONFLICT');
      assert.equal((error.details.issue as { title: string }).title, 'Won');
      return true;
    },
  );
});

test('dragging an issue between statuses keeps a stable order', async () => {
  const { lead, project } = await seed();
  const a = await createIssue({ project, title: 'A', reporter: lead, status: 'todo' });
  const b = await createIssue({ project, title: 'B', reporter: lead, status: 'todo' });
  const c = await createIssue({ project, title: 'C', reporter: lead, status: 'todo' });

  // Created newest-first, so the column reads C, B, A.
  assert.deepEqual((await listIssues(project.id, { status: 'todo' })).map((i) => i.title), ['C', 'B', 'A']);

  const moved = await moveIssue({
    project, issueId: c.id, status: 'in_progress', beforeId: null, baseVersion: c.version,
  });
  assert.equal(moved.status, 'in_progress');
  assert.deepEqual((await listIssues(project.id, { status: 'todo' })).map((i) => i.title), ['B', 'A']);

  // Drop A below B.
  await moveIssue({ project, issueId: a.id, status: 'todo', beforeId: b.id, baseVersion: a.version });
  assert.deepEqual((await listIssues(project.id, { status: 'todo' })).map((i) => i.title), ['B', 'A']);
});

test('two people dropping different issues into the same gap both land', async () => {
  const { lead, project } = await seed();
  const anchor = await createIssue({ project, title: 'Anchor', reporter: lead, status: 'todo' });
  const one = await createIssue({ project, title: 'One', reporter: lead, status: 'backlog' });
  const two = await createIssue({ project, title: 'Two', reporter: lead, status: 'backlog' });

  const [first, second] = await Promise.all([
    moveIssue({ project, issueId: one.id, status: 'todo', beforeId: anchor.id, baseVersion: one.version }),
    moveIssue({ project, issueId: two.id, status: 'todo', beforeId: anchor.id, baseVersion: two.version }),
  ]);
  assert.notEqual(first.sortKey, second.sortKey, 'both drops minted the same key');

  const order = (await listIssues(project.id, { status: 'todo' })).map((i) => i.title);
  assert.equal(order.length, 3);
  assert.equal(order[0], 'Anchor');
});

test('a stale drag is rejected', async () => {
  const { lead, project } = await seed();
  const issue = await createIssue({ project, title: 'Contested', reporter: lead, status: 'todo' });
  const move = (status: 'in_progress' | 'done') =>
    moveIssue({ project, issueId: issue.id, status, beforeId: null, baseVersion: issue.version });

  const results = await Promise.allSettled([move('in_progress'), move('done')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejection = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal((rejection.reason as AppError).code, 'CONFLICT');
});

test('“for you” lists what is assigned to me, urgent first, and hides done work', async () => {
  const { lead, dev, project } = await seed();
  const low = await createIssue({ project, title: 'Low', reporter: lead, assigneeId: dev.id, priority: 'low' });
  const urgent = await createIssue({ project, title: 'Urgent', reporter: lead, assigneeId: dev.id, priority: 'urgent' });
  const finished = await createIssue({ project, title: 'Finished', reporter: lead, assigneeId: dev.id });
  await updateIssue({ issueId: finished.id, patch: { status: 'done' } });
  await createIssue({ project, title: 'Someone else', reporter: lead, assigneeId: lead.id });

  const mine = await listAssignedTo(dev.id);
  assert.deepEqual(mine.map((i) => i.title), ['Urgent', 'Low']);
  assert.ok(!mine.some((i) => i.id === finished.id), 'done work is not still on my plate');
  assert.ok(!mine.some((i) => i.id === low.id && i.assigneeId !== dev.id));
  assert.equal(urgent.priority, 'urgent');
});

test('recent lists what I looked at, most recent first, and survives deletion', async () => {
  const { lead, project } = await seed();
  const issue = await createIssue({ project, title: 'Look at me', reporter: lead });
  const board = await createBoard({ title: 'A retro', kind: 'retro' });

  await recordView(lead.id, 'project', project.id);
  await recordView(lead.id, 'issue', issue.id);
  await recordView(lead.id, 'board', board.id);

  const recent = await listRecent(lead.id);
  assert.deepEqual(recent.map((r) => r.entityType), ['board', 'issue', 'project']);
  assert.equal(recent[0]!.title, 'A retro');
  assert.equal(recent[1]!.href, `/projects/PAY/issues/${issue.number}`);

  // Viewing again moves it to the top rather than adding a duplicate.
  await recordView(lead.id, 'project', project.id);
  const after = await listRecent(lead.id);
  assert.equal(after.length, 3, 'no duplicate rows');
  assert.equal(after[0]!.entityType, 'project');
});

test('starring toggles, and starred things resolve to links', async () => {
  const { lead, project } = await seed();
  const board = await createBoard({ title: 'A retro', kind: 'retro' });

  assert.equal(await toggleStar(lead.id, 'project', project.id), true);
  assert.equal(await toggleStar(lead.id, 'board', board.id), true);
  assert.deepEqual((await listStarred(lead.id)).map((s) => s.entityType).sort(), ['board', 'project']);

  assert.equal(await toggleStar(lead.id, 'project', project.id), false, 'starring again unstars');
  assert.deepEqual((await listStarred(lead.id)).map((s) => s.entityType), ['board']);
});

test('dashboard stats count every issue exactly once', async () => {
  const { lead, dev, project } = await seed();
  await createIssue({ project, title: 'A', reporter: lead, assigneeId: dev.id, priority: 'urgent', status: 'todo' });
  await createIssue({ project, title: 'B', reporter: lead, assigneeId: dev.id, priority: 'low', status: 'todo' });
  await createIssue({ project, title: 'C', reporter: lead, priority: 'high', status: 'in_progress' });
  await createIssue({ project, title: 'D', reporter: lead, priority: 'medium' });

  const stats = await projectStats(project.id, dev.id);
  assert.equal(stats.total, 4);
  assert.equal(stats.byStatus.todo, 2);
  assert.equal(stats.byStatus.in_progress, 1);
  assert.equal(stats.byStatus.backlog, 1);
  assert.equal(stats.byPriority.urgent, 1);
  assert.equal(stats.unassigned, 2);
  assert.equal(stats.mine, 2);
  assert.equal(
    Object.values(stats.byStatus).reduce((a, b) => a + b, 0),
    stats.total,
    'the status breakdown must add up to the total',
  );
});

test('accounts: sign in works, wrong password does not', async () => {
  await seed();
  assert.ok(await authenticate('lead@example.com', 'correct horse'));
  assert.ok(await authenticate('LEAD@EXAMPLE.COM', 'correct horse'), 'email is case-insensitive');
  assert.equal(await authenticate('lead@example.com', 'wrong'), undefined);
  await assert.rejects(
    () => createUser({ email: 'lead@example.com', password: 'another one', name: 'Impostor' }),
    (e: AppError) => e.code === 'CONFLICT',
  );
});

test('an issue is findable by its human key', async () => {
  const { lead, project } = await seed();
  await createIssue({ project, title: 'First', reporter: lead });
  const second = await createIssue({ project, title: 'Second', reporter: lead });
  const found = await getIssue('pay', second.number);
  assert.equal(found?.title, 'Second');
  assert.equal(found?.key, 'PAY-2');
  assert.equal(await getIssue('PAY', 999), undefined);
});

test('a return path is only honoured when it is same-site', async () => {
  // An absolute URL in a form field would make "save" an open redirect.
  assert.equal(safeReturnTo('/projects/PAY/board', '/fallback'), '/projects/PAY/board');
  assert.equal(safeReturnTo('/recent?x=1', '/fallback'), '/recent?x=1');
  assert.equal(safeReturnTo('https://evil.example.com', '/fallback'), '/fallback');
  assert.equal(safeReturnTo('//evil.example.com', '/fallback'), '/fallback');
  assert.equal(safeReturnTo('javascript:alert(1)', '/fallback'), '/fallback');
  assert.equal(safeReturnTo(undefined, '/fallback'), '/fallback');
  assert.equal(safeReturnTo(42, '/fallback'), '/fallback');
});
