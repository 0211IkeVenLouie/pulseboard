import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createBoard, getBoardBySlug, getDemoBoard, type BoardKind } from './boards.js';
import { pool } from './db.js';
import { env } from './env.js';
import { migrate } from './migrate.js';
import { normaliseIdentity } from './identity.js';
import { attachRealtime } from './realtime.js';
import { computeAssetVersion } from './asset-version.js';
import { absoluteTime, initialsOf, relativeTime } from './relative-time.js';
import { registerTrackerApi } from './tracker-json.js';
import { registerTrackerRoutes, userMiddleware } from './tracker-routes.js';
import { seedDemoBoard, seedDemoWorkspace } from './seed.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp(): express.Express {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(rootDir, 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  // Assets are addressed with a ?v= fingerprint, so they can be cached hard
  // and still update the instant a deploy changes them.
  app.locals.assetVersion = computeAssetVersion(path.join(rootDir, 'public'));
  app.use(express.static(path.join(rootDir, 'public'), { maxAge: '365d', immutable: true }));
  app.use(userMiddleware());

  // Anonymous rooms mean no signup, but people still need a stable identity so
  // their cursor, votes and "hidden until reveal" cards survive a refresh.
  app.use((req, res, next) => {
    const identity = normaliseIdentity({ id: req.cookies?.pb_id, name: req.cookies?.pb_name });
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    const options = { httpOnly: false, sameSite: 'lax' as const, maxAge: oneYear };
    if (req.cookies?.pb_id !== identity.id) res.cookie('pb_id', identity.id, options);
    if (req.cookies?.pb_name !== identity.name) res.cookie('pb_name', identity.name, options);
    res.locals.identity = identity;
    next();
  });

  app.locals.relativeTime = relativeTime;
  app.locals.absoluteTime = absoluteTime;
  app.locals.initialsOf = initialsOf;

  registerTrackerApi(app);
  registerTrackerRoutes(app);

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.get('/', async (_req, res) => {
    const demo = await getDemoBoard();
    res.render('index', { demoSlug: demo?.slug ?? null });
  });

  app.get('/demo', async (_req, res) => {
    const demo = (await getDemoBoard()) ?? (await seedDemoBoard());
    res.redirect(`/b/${demo.slug}`);
  });

  app.post('/boards', async (req, res) => {
    const kind: BoardKind = req.body?.kind === 'kanban' ? 'kanban' : 'retro';
    const title = String(req.body?.title ?? '').trim() || (kind === 'retro' ? 'Team retro' : 'Team board');
    const board = await createBoard({ title, kind });
    res.redirect(`/b/${board.slug}`);
  });

  app.get('/b/:slug', async (req, res) => {
    const board = await getBoardBySlug(req.params.slug);
    if (!board) {
      res.status(404).render('not-found');
      return;
    }
    // Signed-in visitors can star a board and see it again later; anonymous
    // ones carry on exactly as before.
    let boardStarred = false;
    if (req.user) {
      const { isStarred, recordView } = await import('./tracker.js');
      boardStarred = await isStarred(req.user.id, 'board', board.id);
      await recordView(req.user.id, 'board', board.id);
    }
    res.render('board', { board, identity: res.locals.identity, boardStarred });
  });

  app.use((_req, res) => res.status(404).render('not-found'));

  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(error);
    res.status(500).render('not-found', { message: 'Something went wrong on our side.' });
  });

  return app;
}

export async function start(): Promise<void> {
  const applied = await migrate();
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  if (env.seedDemo) {
    await seedDemoBoard();
    await seedDemoWorkspace();
  }

  const app = createApp();
  const server = createServer(app);
  attachRealtime(server);
  server.listen(env.port, () => console.log(`pulseboard listening on http://localhost:${env.port}`));

  const shutdown = () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
