/**
 * The board drag endpoint.
 *
 * Deliberately a plain fetch rather than a socket: an issue board is not a
 * retro, nobody is watching it live in another window, and a POST that either
 * succeeds or returns the authoritative issue is enough to keep the optimistic
 * UI honest.
 */
import express from 'express';
import { AppError, httpStatusFor } from './errors.js';
import { getProjectByKey, moveIssue, type IssueStatus } from './tracker.js';

export function registerTrackerApi(app: express.Express): void {
  app.post('/api/projects/:key/issues/:id/move', express.json(), (req, res, next) => {
    (async () => {
      if (!req.user) {
        res.status(401).json({ ok: false, message: 'Sign in first.' });
        return;
      }
      const project = await getProjectByKey(String(req.params.key));
      if (!project) {
        res.status(404).json({ ok: false, message: 'No project with that key.' });
        return;
      }
      try {
        const issue = await moveIssue({
          project,
          issueId: String(req.params.id),
          status: String(req.body?.status ?? '') as IssueStatus,
          beforeId: req.body?.beforeId ? String(req.body.beforeId) : null,
          baseVersion: Number(req.body?.baseVersion ?? -1),
        });
        res.json({ ok: true, issue });
      } catch (error) {
        if (error instanceof AppError) {
          res.status(httpStatusFor[error.code]).json({
            ok: false,
            code: error.code,
            message: error.message,
            issue: error.details.issue,
          });
          return;
        }
        throw error;
      }
    })().catch(next);
  });
}
