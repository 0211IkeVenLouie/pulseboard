import express from 'express';
import {
  authenticate,
  createUser,
  createUserSession,
  destroyUserSession,
  type User,
} from './accounts.js';
import { getDemoBoard } from './boards.js';
import { AppError, httpStatusFor } from './errors.js';
import {
  ALL_STATUSES,
  addComment,
  deleteComment,
  editComment,
  listComments,
  BOARD_STATUSES,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  addMember,
  createIssue,
  createProject,
  deleteIssue,
  getDemoProject,
  getIssue,
  getProjectByKey,
  isMember,
  isStarred,
  listAssignedTo,
  listIssues,
  listMembers,
  listProjectsFor,
  listRecent,
  listReportedBy,
  listStarred,
  projectStats,
  recordView,
  toggleStar,
  updateIssue,
  type IssuePriority,
  type IssueStatus,
  type IssueType,
  type Project,
} from './tracker.js';

export const USER_COOKIE = 'pb_user';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

function asyncRoute(handler: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}


/**
 * Where to send someone after they save.
 *
 * Only same-site paths are honoured: an absolute URL, or anything starting
 * `//`, would turn a form post into an open redirect.
 */
export function safeReturnTo(candidate: unknown, fallback: string): string {
  if (typeof candidate !== 'string') return fallback;
  const value = candidate.trim();
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

/** The page someone came from, for a first render of a form. */
function cameFrom(req: express.Request, fallback: string): string {
  const fromQuery = safeReturnTo(req.query.from, '');
  if (fromQuery) return fromQuery;
  const referer = req.get('referer');
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.host === req.get('host')) return safeReturnTo(url.pathname + url.search, fallback);
    } catch {
      // A malformed referer is not worth an error; fall through.
    }
  }
  return fallback;
}

const oneMonth = { httpOnly: true, sameSite: 'lax' as const, maxAge: 30 * 864e5 };

/** Load the signed-in user, if there is one. The anonymous boards do not care. */
export function userMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    import('./accounts.js')
      .then(({ userForSession }) => userForSession(req.cookies?.[USER_COOKIE]))
      .then((user) => {
        req.user = user;
        res.locals.user = user;
        next();
      })
      .catch(next);
  };
}

async function requireProject(req: express.Request, res: express.Response): Promise<Project | undefined> {
  const project = await getProjectByKey(String(req.params.key));
  if (!project) {
    res.status(404).render('not-found', { message: 'No project with that key.' });
    return undefined;
  }
  // Anyone signed in can look; only members are listed under "your projects".
  return project;
}

export function registerTrackerRoutes(app: express.Express): void {
  app.locals.STATUS_LABELS = STATUS_LABELS;
  app.locals.TYPE_LABELS = TYPE_LABELS;
  app.locals.PRIORITY_LABELS = PRIORITY_LABELS;
  app.locals.BOARD_STATUSES = BOARD_STATUSES;
  app.locals.ALL_STATUSES = ALL_STATUSES;

  const requireUser: express.RequestHandler = (req, res, next) => {
    if (!req.user) {
      res.redirect(`/signin?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    next();
  };

  /* ------------------------------------------------------------ accounts */

  app.get('/signin', (req, res) => {
    if (req.user) return res.redirect('/for-you');
    res.render('signin', { error: null, email: '', next: String(req.query.next ?? '/for-you') });
  });

  app.post('/signin', asyncRoute(async (req, res) => {
    const email = String(req.body?.email ?? '');
    const next = String(req.body?.next ?? '/for-you');
    const user = await authenticate(email, String(req.body?.password ?? ''));
    if (!user) {
      res.status(401).render('signin', { error: 'That email and password do not match.', email, next });
      return;
    }
    res.cookie(USER_COOKIE, await createUserSession(user.id), oneMonth);
    res.redirect(next.startsWith('/') ? next : '/for-you');
  }));

  app.get('/signup', (req, res) => {
    if (req.user) return res.redirect('/for-you');
    res.render('signup', { error: null, values: { name: '', email: '' } });
  });

  app.post('/signup', asyncRoute(async (req, res) => {
    const values = { name: String(req.body?.name ?? ''), email: String(req.body?.email ?? '') };
    try {
      const user = await createUser({ ...values, password: String(req.body?.password ?? '') });
      res.cookie(USER_COOKIE, await createUserSession(user.id), oneMonth);
      res.redirect('/for-you');
    } catch (error) {
      if (error instanceof AppError) {
        res.status(httpStatusFor[error.code]).render('signup', { error: error.message, values });
        return;
      }
      throw error;
    }
  }));

  app.post('/signout', asyncRoute(async (req, res) => {
    await destroyUserSession(req.cookies?.[USER_COOKIE]);
    res.clearCookie(USER_COOKIE);
    res.redirect('/');
  }));

  /** One click into a populated account, same idea as the demo board. */
  app.post('/demo-signin', asyncRoute(async (_req, res) => {
    const { seedDemoWorkspace } = await import('./seed.js');
    const demo = await seedDemoWorkspace();
    res.cookie(USER_COOKIE, await createUserSession(demo.id), oneMonth);
    res.redirect('/for-you');
  }));

  /* -------------------------------------------------------- nav surfaces */

  app.get('/for-you', requireUser, asyncRoute(async (req, res) => {
    const user = req.user!;
    const [assigned, reported, projects, recent] = await Promise.all([
      listAssignedTo(user.id),
      listReportedBy(user.id),
      listProjectsFor(user.id),
      listRecent(user.id, 5),
    ]);
    res.render('tracker/for-you', { assigned, reported, projects, recent, active: 'for-you' });
  }));

  app.get('/recent', requireUser, asyncRoute(async (req, res) => {
    res.render('tracker/recent', { items: await listRecent(req.user!.id, 30), active: 'recent' });
  }));

  app.get('/starred', requireUser, asyncRoute(async (req, res) => {
    res.render('tracker/starred', { items: await listStarred(req.user!.id), active: 'starred' });
  }));

  app.get('/dashboards', requireUser, asyncRoute(async (req, res) => {
    const projects = await listProjectsFor(req.user!.id);
    const stats = await Promise.all(projects.map((project) => projectStats(project.id, req.user!.id)));
    res.render('tracker/dashboards', { stats, active: 'dashboards' });
  }));

  app.get('/projects', requireUser, asyncRoute(async (req, res) => {
    res.render('tracker/projects', { projects: await listProjectsFor(req.user!.id), active: 'projects', error: null });
  }));

  app.post('/projects', requireUser, asyncRoute(async (req, res) => {
    try {
      const project = await createProject({
        key: String(req.body?.key ?? ''),
        name: String(req.body?.name ?? ''),
        description: String(req.body?.description ?? ''),
        lead: req.user!,
      });
      res.redirect(`/projects/${project.key}/board`);
    } catch (error) {
      if (error instanceof AppError) {
        res.status(httpStatusFor[error.code]).render('tracker/projects', {
          projects: await listProjectsFor(req.user!.id),
          active: 'projects',
          error: error.message,
        });
        return;
      }
      throw error;
    }
  }));

  /* -------------------------------------------------------------- boards */

  app.get('/projects/:key/board', requireUser, asyncRoute(async (req, res) => {
    const project = await requireProject(req, res);
    if (!project) return;
    const user = req.user!;
    if (!(await isMember(project.id, user.id))) await addMember(project.id, user.id);
    await recordView(user.id, 'project', project.id);

    const [issues, members, starred] = await Promise.all([
      listIssues(project.id),
      listMembers(project.id),
      isStarred(user.id, 'project', project.id),
    ]);
    res.render('tracker/board', {
      project,
      issues,
      members,
      starred,
      active: 'projects',
      view: 'board',
    });
  }));

  app.get('/projects/:key/backlog', requireUser, asyncRoute(async (req, res) => {
    const project = await requireProject(req, res);
    if (!project) return;
    await recordView(req.user!.id, 'project', project.id);
    const [issues, members, starred] = await Promise.all([
      listIssues(project.id),
      listMembers(project.id),
      isStarred(req.user!.id, 'project', project.id),
    ]);
    res.render('tracker/backlog', { project, issues, members, starred, active: 'projects', view: 'backlog' });
  }));

  app.post('/projects/:key/star', requireUser, asyncRoute(async (req, res) => {
    const project = await requireProject(req, res);
    if (!project) return;
    await toggleStar(req.user!.id, 'project', project.id);
    res.redirect(req.get('referer') ?? `/projects/${project.key}/board`);
  }));

  /* -------------------------------------------------------------- issues */

  app.post('/projects/:key/issues', requireUser, asyncRoute(async (req, res) => {
    const project = await requireProject(req, res);
    if (!project) return;
    const status = String(req.body?.status ?? 'backlog') as IssueStatus;
    const issue = await createIssue({
      project,
      title: String(req.body?.title ?? ''),
      description: String(req.body?.description ?? ''),
      type: (String(req.body?.type ?? 'task') as IssueType),
      priority: (String(req.body?.priority ?? 'medium') as IssuePriority),
      status: ALL_STATUSES.includes(status) ? status : 'backlog',
      assigneeId: req.body?.assigneeId ? String(req.body.assigneeId) : null,
      reporter: req.user!,
    });
    res.redirect(req.get('referer') ?? `/projects/${project.key}/issues/${issue.number}`);
  }));

  app.get('/projects/:key/issues/:number', requireUser, asyncRoute(async (req, res) => {
    const project = await requireProject(req, res);
    if (!project) return;
    const issue = await getIssue(project.key, Number(req.params.number));
    if (!issue) {
      res.status(404).render('not-found', { message: 'No issue with that number.' });
      return;
    }
    await recordView(req.user!.id, 'issue', issue.id);
    const [members, comments] = await Promise.all([listMembers(project.id), listComments(issue.id)]);
    res.render('tracker/issue', {
      project,
      issue,
      members,
      comments,
      active: 'projects',
      error: null,
      editingComment: String(req.query.edit ?? ''),
      returnTo: cameFrom(req, `/projects/${project.key}/board`),
    });
  }));

  app.post('/projects/:key/issues/:number', requireUser, asyncRoute(async (req, res) => {
    const project = await requireProject(req, res);
    if (!project) return;
    const issue = await getIssue(project.key, Number(req.params.number));
    if (!issue) {
      res.status(404).render('not-found', { message: 'No issue with that number.' });
      return;
    }
    const body = req.body ?? {};
    try {
      const patch: Record<string, unknown> = {};
      if (body.title !== undefined) patch.title = String(body.title);
      if (body.description !== undefined) patch.description = String(body.description);
      if (body.type !== undefined) patch.type = String(body.type) as IssueType;
      if (body.status !== undefined) patch.status = String(body.status) as IssueStatus;
      if (body.priority !== undefined) patch.priority = String(body.priority) as IssuePriority;
      // An assignee select always posts, with '' meaning unassigned.
      if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId ? String(body.assigneeId) : null;

      await updateIssue({ issueId: issue.id, baseVersion: Number(body.version), patch });
      const fallback = `/projects/${project.key}/board`;
      const returnTo = safeReturnTo(body.returnTo, fallback);
      // "Stay here" is a real choice: editing a description then being thrown
      // back to the board is worse than staying with the issue.
      if (body.stay) {
        res.redirect(`/projects/${project.key}/issues/${issue.number}?from=${encodeURIComponent(returnTo)}`);
        return;
      }
      res.redirect(`${returnTo}${returnTo.includes('?') ? '&' : '?'}saved=${issue.key}`);
    } catch (error) {
      if (error instanceof AppError) {
        res.status(httpStatusFor[error.code]).render('tracker/issue', {
          project,
          issue: (error.details.issue as typeof issue) ?? issue,
          members: await listMembers(project.id),
          active: 'projects',
          error: error.message,
          returnTo: safeReturnTo(body.returnTo, `/projects/${project.key}/board`),
        });
        return;
      }
      throw error;
    }
  }));

  app.post('/projects/:key/issues/:number/comments', requireUser, asyncRoute(async (req, res) => {
    const project = await requireProject(req, res);
    if (!project) return;
    const issue = await getIssue(project.key, Number(req.params.number));
    if (!issue) {
      res.status(404).render('not-found', { message: 'No issue with that number.' });
      return;
    }
    const back = `/projects/${project.key}/issues/${issue.number}?from=${encodeURIComponent(
      safeReturnTo(req.body?.returnTo, `/projects/${project.key}/board`),
    )}`;
    try {
      await addComment({ issueId: issue.id, authorId: req.user!.id, body: String(req.body?.body ?? '') });
      res.redirect(`${back}#comments`);
    } catch (error) {
      if (error instanceof AppError) {
        const [members, comments] = await Promise.all([listMembers(project.id), listComments(issue.id)]);
        res.status(httpStatusFor[error.code]).render('tracker/issue', {
          project, issue, members, comments, active: 'projects',
          error: error.message, editingComment: '',
          returnTo: safeReturnTo(req.body?.returnTo, `/projects/${project.key}/board`),
        });
        return;
      }
      throw error;
    }
  }));

  app.post('/projects/:key/issues/:number/comments/:commentId', requireUser, asyncRoute(async (req, res) => {
    const project = await requireProject(req, res);
    if (!project) return;
    const back = `/projects/${project.key}/issues/${req.params.number}`;
    const action = String(req.body?.action ?? 'edit');
    try {
      if (action === 'delete') {
        await deleteComment(String(req.params.commentId), req.user!.id);
      } else {
        await editComment({
          commentId: String(req.params.commentId),
          authorId: req.user!.id,
          body: String(req.body?.body ?? ''),
        });
      }
      res.redirect(`${back}#comments`);
    } catch (error) {
      if (error instanceof AppError) {
        res.status(httpStatusFor[error.code]).render('not-found', { message: error.message });
        return;
      }
      throw error;
    }
  }));

  app.post('/projects/:key/issues/:number/delete', requireUser, asyncRoute(async (req, res) => {
    const project = await requireProject(req, res);
    if (!project) return;
    const issue = await getIssue(project.key, Number(req.params.number));
    if (issue) await deleteIssue(project.id, issue.id);
    const returnTo = safeReturnTo(req.body?.returnTo, `/projects/${project.key}/backlog`);
    // Never bounce back to the issue we just deleted.
    res.redirect(returnTo.includes(`/issues/${req.params.number}`) ? `/projects/${project.key}/backlog` : returnTo);
  }));

  /* Anonymous boards can be starred too, once you have an account. */
  app.post('/b/:slug/star', requireUser, asyncRoute(async (req, res) => {
    const { getBoardBySlug } = await import('./boards.js');
    const board = await getBoardBySlug(String(req.params.slug));
    if (board) await toggleStar(req.user!.id, 'board', board.id);
    res.redirect(`/b/${req.params.slug}`);
  }));

  app.get('/demo-project', asyncRoute(async (_req, res) => {
    const project = await getDemoProject();
    const board = await getDemoBoard();
    res.redirect(project ? `/projects/${project.key}/board` : board ? `/b/${board.slug}` : '/');
  }));
}
