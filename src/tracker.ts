import { one, query, transaction } from './db.js';
import { AppError } from './errors.js';
import { keyBetween } from './ordering.js';
import type { User } from './accounts.js';

export type IssueType = 'task' | 'bug' | 'story';
export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
export type IssuePriority = 'low' | 'medium' | 'high' | 'urgent';

/** The columns of the board, in order. `backlog` deliberately is not one. */
export const BOARD_STATUSES: IssueStatus[] = ['todo', 'in_progress', 'in_review', 'done'];
export const ALL_STATUSES: IssueStatus[] = ['backlog', ...BOARD_STATUSES];

export const STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};
export const TYPE_LABELS: Record<IssueType, string> = { task: 'Task', bug: 'Bug', story: 'Story' };
export const PRIORITY_LABELS: Record<IssuePriority, string> = {
  low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent',
};

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  leadId: string | null;
  isDemo: boolean;
}

export interface Issue {
  id: string;
  projectId: string;
  projectKey: string;
  number: number;
  /** "PAY-14" — what people actually call it. */
  key: string;
  title: string;
  description: string;
  type: IssueType;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  assigneeName: string | null;
  reporterId: string | null;
  reporterName: string | null;
  sortKey: string;
  version: number;
  updatedAt: Date;
}

/* ------------------------------------------------------------------ rows */

interface ProjectRow {
  id: string; key: string; name: string; description: string;
  lead_id: string | null; is_demo: boolean;
}
const PROJECT_COLUMNS = 'id, key, name, description, lead_id, is_demo';
const toProject = (r: ProjectRow): Project => ({
  id: r.id, key: r.key, name: r.name, description: r.description, leadId: r.lead_id, isDemo: r.is_demo,
});

interface IssueRow {
  id: string; project_id: string; project_key: string; number: number; title: string;
  description: string; type: IssueType; status: IssueStatus; priority: IssuePriority;
  assignee_id: string | null; assignee_name: string | null;
  reporter_id: string | null; reporter_name: string | null;
  sort_key: string; version: number; updated_at: Date;
}

const ISSUE_SELECT = `
  SELECT i.id, i.project_id, p.key AS project_key, i.number, i.title, i.description, i.type,
         i.status, i.priority, i.assignee_id, a.name AS assignee_name,
         i.reporter_id, r.name AS reporter_name, i.sort_key, i.version, i.updated_at
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    LEFT JOIN users a ON a.id = i.assignee_id
    LEFT JOIN users r ON r.id = i.reporter_id`;

const toIssue = (r: IssueRow): Issue => ({
  id: r.id,
  projectId: r.project_id,
  projectKey: r.project_key,
  number: r.number,
  key: `${r.project_key}-${r.number}`,
  title: r.title,
  description: r.description,
  type: r.type,
  status: r.status,
  priority: r.priority,
  assigneeId: r.assignee_id,
  assigneeName: r.assignee_name,
  reporterId: r.reporter_id,
  reporterName: r.reporter_name,
  sortKey: r.sort_key,
  version: r.version,
  updatedAt: r.updated_at,
});

/* -------------------------------------------------------------- projects */

export async function createProject(input: {
  key: string;
  name: string;
  description?: string;
  lead: User;
  isDemo?: boolean;
}): Promise<Project> {
  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
    throw new AppError('INVALID', 'A project key is 2–10 letters or digits, starting with a letter. Like PAY.');
  }
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError('INVALID', 'Give the project a name.');

  return transaction(async (client) => {
    let row;
    try {
      row = (
        await client.query<ProjectRow>(
          `INSERT INTO projects (key, name, description, lead_id, is_demo)
           VALUES ($1, $2, $3, $4, $5) RETURNING ${PROJECT_COLUMNS}`,
          [key, name, (input.description ?? '').trim().slice(0, 500), input.lead.id, input.isDemo ?? false],
        )
      ).rows[0]!;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new AppError('CONFLICT', `The key ${key} is taken. Pick another.`);
      }
      throw error;
    }
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'lead')`,
      [row.id, input.lead.id],
    );
    return toProject(row);
  });
}

export async function getProjectByKey(key: string): Promise<Project | undefined> {
  const row = await one<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE key = upper($1)`, [key]);
  return row ? toProject(row) : undefined;
}

export async function getDemoProject(): Promise<Project | undefined> {
  const row = await one<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM projects WHERE is_demo = true ORDER BY created_at LIMIT 1`,
  );
  return row ? toProject(row) : undefined;
}

export async function listProjectsFor(userId: string): Promise<Array<Project & { issueCount: number }>> {
  const rows = await query<ProjectRow & { issue_count: number }>(
    `SELECT p.id, p.key, p.name, p.description, p.lead_id, p.is_demo,
            (SELECT COUNT(*) FROM issues i WHERE i.project_id = p.id)::int AS issue_count
       FROM projects p
       JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
      ORDER BY p.created_at`,
    [userId],
  );
  return rows.map((row) => ({ ...toProject(row), issueCount: row.issue_count }));
}

/**
 * Delete a project and everything under it.
 *
 * Issues, members and comments go by cascade. Stars and recent views do not:
 * they point at an id without a foreign key, because one row has to be able to
 * reference a project, a board or an issue. Orphans there are harmless (both
 * lists drop anything that no longer resolves) but they would accumulate, so
 * they are cleared explicitly.
 */
export async function deleteProject(projectId: string, userId: string): Promise<void> {
  return transaction(async (client) => {
    const project = (
      await client.query<{ lead_id: string | null }>('SELECT lead_id FROM projects WHERE id = $1', [projectId])
    ).rows[0];
    if (!project) throw new AppError('NOT_FOUND', 'That project is already gone.');
    if (project.lead_id !== userId) {
      throw new AppError('FORBIDDEN', 'Only the project lead can delete it.');
    }

    const issueIds = (
      await client.query<{ id: string }>('SELECT id FROM issues WHERE project_id = $1', [projectId])
    ).rows.map((row) => row.id);
    const referenced = [projectId, ...issueIds];

    await client.query('DELETE FROM stars WHERE entity_id = ANY($1::uuid[])', [referenced]);
    await client.query('DELETE FROM recent_views WHERE entity_id = ANY($1::uuid[])', [referenced]);
    await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });
}

export async function listMembers(projectId: string): Promise<User[]> {
  const rows = await query<{ id: string; email: string; name: string; is_demo: boolean }>(
    `SELECT u.id, u.email, u.name, u.is_demo
       FROM project_members m JOIN users u ON u.id = m.user_id
      WHERE m.project_id = $1 ORDER BY u.name`,
    [projectId],
  );
  return rows.map((r) => ({ id: r.id, email: r.email, name: r.name, isDemo: r.is_demo }));
}

export async function isMember(projectId: string, userId: string): Promise<boolean> {
  const row = await one('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
  return Boolean(row);
}

export async function addMember(projectId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [projectId, userId],
  );
}

/* ---------------------------------------------------------------- issues */

export async function createIssue(input: {
  project: Project;
  title: string;
  description?: string;
  type?: IssueType;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeId?: string | null;
  reporter: User;
}): Promise<Issue> {
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new AppError('INVALID', 'An issue needs a title.');
  const status = input.status ?? 'backlog';

  return transaction(async (client) => {
    // The counter lives on the project row, so two people filing at the same
    // instant get PAY-14 and PAY-15 rather than both getting PAY-14.
    const counter = (
      await client.query<{ issue_counter: number }>(
        'UPDATE projects SET issue_counter = issue_counter + 1 WHERE id = $1 RETURNING issue_counter',
        [input.project.id],
      )
    ).rows[0]!;

    const head = (
      await client.query<{ sort_key: string }>(
        'SELECT sort_key FROM issues WHERE project_id = $1 AND status = $2 ORDER BY sort_key, id LIMIT 1',
        [input.project.id, status],
      )
    ).rows[0];

    const inserted = (
      await client.query<{ id: string }>(
        `INSERT INTO issues (project_id, number, title, description, type, status, priority,
                             assignee_id, reporter_id, sort_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          input.project.id,
          counter.issue_counter,
          title,
          (input.description ?? '').trim().slice(0, 4000),
          input.type ?? 'task',
          status,
          input.priority ?? 'medium',
          input.assigneeId ?? null,
          input.reporter.id,
          keyBetween(null, head?.sort_key ?? null),
        ],
      )
    ).rows[0]!;

    const row = (await client.query<IssueRow>(`${ISSUE_SELECT} WHERE i.id = $1`, [inserted.id])).rows[0]!;
    return toIssue(row);
  });
}

export async function getIssue(projectKey: string, number: number): Promise<Issue | undefined> {
  const row = await one<IssueRow>(
    `${ISSUE_SELECT} WHERE p.key = upper($1) AND i.number = $2`,
    [projectKey, number],
  );
  return row ? toIssue(row) : undefined;
}

export async function listIssues(projectId: string, options: { status?: IssueStatus } = {}): Promise<Issue[]> {
  const rows = await query<IssueRow>(
    `${ISSUE_SELECT} WHERE i.project_id = $1 ${options.status ? 'AND i.status = $2' : ''}
      ORDER BY i.sort_key, i.id`,
    options.status ? [projectId, options.status] : [projectId],
  );
  return rows.map(toIssue);
}

export async function listAssignedTo(userId: string): Promise<Issue[]> {
  const rows = await query<IssueRow>(
    `${ISSUE_SELECT} WHERE i.assignee_id = $1 AND i.status <> 'done'
      ORDER BY CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               i.updated_at DESC
      LIMIT 50`,
    [userId],
  );
  return rows.map(toIssue);
}

export async function listReportedBy(userId: string): Promise<Issue[]> {
  const rows = await query<IssueRow>(
    `${ISSUE_SELECT} WHERE i.reporter_id = $1 ORDER BY i.updated_at DESC LIMIT 20`,
    [userId],
  );
  return rows.map(toIssue);
}

export interface IssuePatch {
  title?: string;
  description?: string;
  type?: IssueType;
  priority?: IssuePriority;
  assigneeId?: string | null;
  status?: IssueStatus;
}

export async function updateIssue(input: {
  issueId: string;
  patch: IssuePatch;
  baseVersion?: number;
}): Promise<Issue> {
  return transaction(async (client) => {
    const current = (
      await client.query<{ version: number; status: IssueStatus; project_id: string }>(
        'SELECT version, status, project_id FROM issues WHERE id = $1 FOR UPDATE',
        [input.issueId],
      )
    ).rows[0];
    if (!current) throw new AppError('NOT_FOUND', 'That issue no longer exists.');
    if (input.baseVersion !== undefined && current.version !== input.baseVersion) {
      const authoritative = toIssue(
        (await client.query<IssueRow>(`${ISSUE_SELECT} WHERE i.id = $1`, [input.issueId])).rows[0]!,
      );
      throw new AppError('CONFLICT', 'Someone else changed this issue first.', { issue: authoritative });
    }

    const sets: string[] = [];
    const values: unknown[] = [input.issueId];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (input.patch.title !== undefined) {
      const title = input.patch.title.trim().slice(0, 200);
      if (!title) throw new AppError('INVALID', 'An issue needs a title.');
      push('title', title);
    }
    if (input.patch.description !== undefined) push('description', input.patch.description.trim().slice(0, 4000));
    if (input.patch.type !== undefined) push('type', input.patch.type);
    if (input.patch.priority !== undefined) push('priority', input.patch.priority);
    if (input.patch.assigneeId !== undefined) push('assignee_id', input.patch.assigneeId);
    if (input.patch.status !== undefined && input.patch.status !== current.status) {
      push('status', input.patch.status);
      // Moving between statuses without a drop position: put it on top.
      const head = (
        await client.query<{ sort_key: string }>(
          'SELECT sort_key FROM issues WHERE project_id = $1 AND status = $2 AND id <> $3 ORDER BY sort_key, id LIMIT 1',
          [current.project_id, input.patch.status, input.issueId],
        )
      ).rows[0];
      push('sort_key', keyBetween(null, head?.sort_key ?? null));
    }

    if (sets.length === 0) {
      return toIssue((await client.query<IssueRow>(`${ISSUE_SELECT} WHERE i.id = $1`, [input.issueId])).rows[0]!);
    }

    await client.query(
      `UPDATE issues SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`,
      values,
    );
    return toIssue((await client.query<IssueRow>(`${ISSUE_SELECT} WHERE i.id = $1`, [input.issueId])).rows[0]!);
  });
}

/**
 * Drag an issue to a status, at a position.
 *
 * Exactly the arrangement the retro board uses: the destination is locked, the
 * client's version is checked, and the opposite bound is re-read from live
 * adjacency rather than trusted from the browser.
 */
export async function moveIssue(input: {
  project: Project;
  issueId: string;
  status: IssueStatus;
  beforeId: string | null;
  baseVersion: number;
}): Promise<Issue> {
  if (!ALL_STATUSES.includes(input.status)) throw new AppError('INVALID', 'Unknown status.');

  return transaction(async (client) => {
    const current = (
      await client.query<{ version: number; project_id: string }>(
        'SELECT version, project_id FROM issues WHERE id = $1 FOR UPDATE',
        [input.issueId],
      )
    ).rows[0];
    if (!current || current.project_id !== input.project.id) {
      throw new AppError('NOT_FOUND', 'That issue no longer exists.');
    }
    if (current.version !== input.baseVersion) {
      const authoritative = toIssue(
        (await client.query<IssueRow>(`${ISSUE_SELECT} WHERE i.id = $1`, [input.issueId])).rows[0]!,
      );
      throw new AppError('CONFLICT', 'Someone else moved this issue first.', { issue: authoritative });
    }

    // Serialise everyone dropping into this column, so two drops cannot read
    // the same neighbours and mint the same key.
    await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [input.project.id]);

    const anchor = input.beforeId
      ? (
          await client.query<{ sort_key: string }>(
            'SELECT sort_key FROM issues WHERE id = $1 AND project_id = $2 AND status = $3 AND id <> $4',
            [input.beforeId, input.project.id, input.status, input.issueId],
          )
        ).rows[0]
      : undefined;

    let beforeKey: string | null = null;
    let afterKey: string | null = null;
    if (anchor) {
      beforeKey = anchor.sort_key;
      afterKey =
        (
          await client.query<{ sort_key: string }>(
            `SELECT sort_key FROM issues
              WHERE project_id = $1 AND status = $2 AND id <> $3 AND sort_key > $4
              ORDER BY sort_key LIMIT 1`,
            [input.project.id, input.status, input.issueId, anchor.sort_key],
          )
        ).rows[0]?.sort_key ?? null;
    } else if (input.beforeId) {
      // The issue it was dropped under has moved away; land at the bottom.
      beforeKey =
        (
          await client.query<{ sort_key: string }>(
            `SELECT sort_key FROM issues WHERE project_id = $1 AND status = $2 AND id <> $3
              ORDER BY sort_key DESC LIMIT 1`,
            [input.project.id, input.status, input.issueId],
          )
        ).rows[0]?.sort_key ?? null;
    } else {
      afterKey =
        (
          await client.query<{ sort_key: string }>(
            `SELECT sort_key FROM issues WHERE project_id = $1 AND status = $2 AND id <> $3
              ORDER BY sort_key LIMIT 1`,
            [input.project.id, input.status, input.issueId],
          )
        ).rows[0]?.sort_key ?? null;
    }

    await client.query(
      `UPDATE issues SET status = $2, sort_key = $3, version = version + 1, updated_at = now() WHERE id = $1`,
      [input.issueId, input.status, keyBetween(beforeKey, afterKey)],
    );
    return toIssue((await client.query<IssueRow>(`${ISSUE_SELECT} WHERE i.id = $1`, [input.issueId])).rows[0]!);
  });
}

export async function deleteIssue(projectId: string, issueId: string): Promise<void> {
  const deleted = await query('DELETE FROM issues WHERE id = $1 AND project_id = $2 RETURNING id', [issueId, projectId]);
  if (deleted.length === 0) throw new AppError('NOT_FOUND', 'That issue is already gone.');
}

/* ------------------------------------------------- stars & recent views */

export type EntityType = 'project' | 'board' | 'issue';

export async function toggleStar(userId: string, entityType: 'project' | 'board', entityId: string): Promise<boolean> {
  const removed = await query('DELETE FROM stars WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3 RETURNING 1', [
    userId, entityType, entityId,
  ]);
  if (removed.length > 0) return false;
  await query(
    'INSERT INTO stars (user_id, entity_type, entity_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [userId, entityType, entityId],
  );
  return true;
}

export async function isStarred(userId: string, entityType: string, entityId: string): Promise<boolean> {
  const row = await one('SELECT 1 FROM stars WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3', [
    userId, entityType, entityId,
  ]);
  return Boolean(row);
}

/** Records a visit. Upserting means "recent" is last-visited, not first. */
export async function recordView(userId: string, entityType: EntityType, entityId: string): Promise<void> {
  await query(
    `INSERT INTO recent_views (user_id, entity_type, entity_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET viewed_at = now()`,
    [userId, entityType, entityId],
  );
}

export interface Bookmark {
  entityType: EntityType;
  entityId: string;
  title: string;
  subtitle: string;
  href: string;
  at: Date;
}

/**
 * Resolve saved references into something renderable.
 *
 * Stars and recent views point at three different kinds of thing, so this is
 * one query per kind rather than a polymorphic join — simpler to read, and the
 * lists are short by construction.
 */
async function resolve(
  rows: Array<{ entity_type: EntityType; entity_id: string; at: Date }>,
): Promise<Bookmark[]> {
  if (rows.length === 0) return [];
  const byType = (type: EntityType) => rows.filter((r) => r.entity_type === type).map((r) => r.entity_id);

  const [projects, boards, issues] = await Promise.all([
    byType('project').length
      ? query<{ id: string; key: string; name: string; count: number }>(
          `SELECT p.id, p.key, p.name, (SELECT COUNT(*) FROM issues i WHERE i.project_id = p.id)::int AS count
             FROM projects p WHERE p.id = ANY($1::uuid[])`,
          [byType('project')],
        )
      : [],
    byType('board').length
      ? query<{ id: string; slug: string; title: string; kind: string }>(
          'SELECT id, slug, title, kind FROM boards WHERE id = ANY($1::uuid[])',
          [byType('board')],
        )
      : [],
    byType('issue').length
      ? query<{ id: string; key: string; number: number; title: string; status: IssueStatus }>(
          `SELECT i.id, p.key, i.number, i.title, i.status
             FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = ANY($1::uuid[])`,
          [byType('issue')],
        )
      : [],
  ]);

  const map = new Map<string, Omit<Bookmark, 'at'>>();
  for (const p of projects) {
    map.set(p.id, {
      entityType: 'project', entityId: p.id, title: p.name,
      subtitle: `${p.key} · ${p.count} issue${p.count === 1 ? '' : 's'}`,
      href: `/projects/${p.key}/board`,
    });
  }
  for (const b of boards) {
    map.set(b.id, {
      entityType: 'board', entityId: b.id, title: b.title,
      subtitle: `${b.kind} board`, href: `/b/${b.slug}`,
    });
  }
  for (const i of issues) {
    map.set(i.id, {
      entityType: 'issue', entityId: i.id, title: i.title,
      subtitle: `${i.key}-${i.number} · ${STATUS_LABELS[i.status]}`,
      href: `/projects/${i.key}/issues/${i.number}`,
    });
  }

  // Keep the order the caller asked for, and drop anything since deleted.
  return rows.flatMap((row) => {
    const found = map.get(row.entity_id);
    return found ? [{ ...found, at: row.at }] : [];
  });
}

/** Take one entry out of someone's Recent list, without touching the thing. */
export async function dismissRecent(userId: string, entityType: EntityType, entityId: string): Promise<void> {
  await query('DELETE FROM recent_views WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3', [
    userId, entityType, entityId,
  ]);
}

export async function clearRecent(userId: string): Promise<void> {
  await query('DELETE FROM recent_views WHERE user_id = $1', [userId]);
}

export async function listRecent(userId: string, limit = 20): Promise<Bookmark[]> {
  const rows = await query<{ entity_type: EntityType; entity_id: string; at: Date }>(
    'SELECT entity_type, entity_id, viewed_at AS at FROM recent_views WHERE user_id = $1 ORDER BY viewed_at DESC LIMIT $2',
    [userId, limit],
  );
  return resolve(rows);
}

export async function listStarred(userId: string): Promise<Bookmark[]> {
  const rows = await query<{ entity_type: EntityType; entity_id: string; at: Date }>(
    'SELECT entity_type, entity_id, starred_at AS at FROM stars WHERE user_id = $1 ORDER BY starred_at DESC',
    [userId],
  );
  return resolve(rows);
}

/* ------------------------------------------------------------ dashboard */

export interface ProjectStats {
  project: Project;
  total: number;
  byStatus: Record<IssueStatus, number>;
  byPriority: Record<IssuePriority, number>;
  unassigned: number;
  mine: number;
}

export async function projectStats(projectId: string, userId: string): Promise<ProjectStats> {
  const [project, rows] = await Promise.all([
    one<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`, [projectId]),
    query<{ status: IssueStatus; priority: IssuePriority; assignee_id: string | null; count: number }>(
      `SELECT status, priority, assignee_id, COUNT(*)::int AS count
         FROM issues WHERE project_id = $1 GROUP BY status, priority, assignee_id`,
      [projectId],
    ),
  ]);

  const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<IssueStatus, number>;
  const byPriority = { low: 0, medium: 0, high: 0, urgent: 0 };
  let total = 0;
  let unassigned = 0;
  let mine = 0;

  for (const row of rows) {
    total += row.count;
    byStatus[row.status] += row.count;
    byPriority[row.priority] += row.count;
    if (row.assignee_id === null) unassigned += row.count;
    if (row.assignee_id === userId) mine += row.count;
  }

  return { project: toProject(project!), total, byStatus, byPriority, unassigned, mine };
}


/* -------------------------------------------------------------- comments */

export interface Comment {
  id: string;
  issueId: string;
  authorId: string | null;
  authorName: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}

interface CommentRow {
  id: string; issue_id: string; author_id: string | null; author_name: string | null;
  body: string; created_at: Date; edited_at: Date | null;
}

const toComment = (r: CommentRow): Comment => ({
  id: r.id,
  issueId: r.issue_id,
  authorId: r.author_id,
  // A comment outlives the account that wrote it; the words still matter.
  authorName: r.author_name ?? 'Former member',
  body: r.body,
  createdAt: r.created_at,
  editedAt: r.edited_at,
});

export async function listComments(issueId: string): Promise<Comment[]> {
  const rows = await query<CommentRow>(
    `SELECT c.id, c.issue_id, c.author_id, u.name AS author_name, c.body, c.created_at, c.edited_at
       FROM comments c LEFT JOIN users u ON u.id = c.author_id
      WHERE c.issue_id = $1 ORDER BY c.created_at`,
    [issueId],
  );
  return rows.map(toComment);
}

export async function addComment(input: { issueId: string; authorId: string; body: string }): Promise<Comment> {
  const body = input.body.trim().slice(0, 4000);
  if (!body) throw new AppError('INVALID', 'Write something first.');
  const row = await one<CommentRow>(
    `WITH inserted AS (
       INSERT INTO comments (issue_id, author_id, body) VALUES ($1, $2, $3)
       RETURNING id, issue_id, author_id, body, created_at, edited_at
     )
     SELECT i.*, u.name AS author_name FROM inserted i LEFT JOIN users u ON u.id = i.author_id`,
    [input.issueId, input.authorId, body],
  );
  return toComment(row!);
}

/** Only the author may change or remove their own comment. */
export async function editComment(input: { commentId: string; authorId: string; body: string }): Promise<Comment> {
  const body = input.body.trim().slice(0, 4000);
  if (!body) throw new AppError('INVALID', 'A comment cannot be empty. Delete it instead.');
  const row = await one<CommentRow>(
    `WITH updated AS (
       UPDATE comments SET body = $3, edited_at = now()
        WHERE id = $1 AND author_id = $2
        RETURNING id, issue_id, author_id, body, created_at, edited_at
     )
     SELECT u.*, usr.name AS author_name FROM updated u LEFT JOIN users usr ON usr.id = u.author_id`,
    [input.commentId, input.authorId, body],
  );
  if (!row) throw new AppError('FORBIDDEN', 'You can only edit your own comments.');
  return toComment(row);
}

export async function deleteComment(commentId: string, authorId: string): Promise<void> {
  const deleted = await query('DELETE FROM comments WHERE id = $1 AND author_id = $2 RETURNING id', [
    commentId,
    authorId,
  ]);
  if (deleted.length === 0) throw new AppError('FORBIDDEN', 'You can only delete your own comments.');
}

export async function countComments(issueIds: string[]): Promise<Map<string, number>> {
  if (issueIds.length === 0) return new Map();
  const rows = await query<{ issue_id: string; count: number }>(
    'SELECT issue_id, COUNT(*)::int AS count FROM comments WHERE issue_id = ANY($1::uuid[]) GROUP BY issue_id',
    [issueIds],
  );
  return new Map(rows.map((row) => [row.issue_id, row.count]));
}
