import * as z from 'zod/v4';
import type { Express, Request, Response } from 'express';
import express from 'express';
import { publicError } from '../codeforces/errors.js';
import type { InternalIdentityVerifier } from '../auth/internalOidc.js';

const discovery = z.object({ reason: z.literal('discovery') }).strict();
const task = z.object({
  reason: z.enum(['registration', 'start', 'problem', 'manual_auth', 'rating']),
  runId: z.uuid(), contestId: z.number().int().positive().safe(),
  taskName: z.string().regex(/^projects\/[A-Za-z0-9:._-]+\/locations\/[a-z0-9-]+\/queues\/[a-z0-9-]+\/tasks\/[a-z0-9-]+$/),
}).strict();
export const internalReconcileInput = z.union([discovery, task]);
export type InternalReconcileInput = z.infer<typeof internalReconcileInput>;

export interface InternalOrchestrator {
  verifier: InternalIdentityVerifier;
  reconcile(input: InternalReconcileInput): Promise<void>;
}

export function registerInternalOrchestrator(app: Express, controller: InternalOrchestrator,
  isStopping: () => boolean): void {
  app.post('/internal/orchestrator/reconcile', express.json({ limit: '4kb' }), async (req: Request, res: Response) => {
    if (isStopping()) { res.status(503).json({ error: { code: 'SHUTTING_DOWN', message: 'Service is shutting down.' } }); return; }
    const bearer = /^Bearer\s+([^\s]+)$/i.exec(req.headers.authorization ?? '');
    if (!bearer || !await controller.verifier.verify(bearer[1]!)) {
      res.status(401).json({ error: { code: 'INTERNAL_AUTH_REQUIRED', message: 'Valid internal OIDC identity required.' } }); return;
    }
    const parsed = internalReconcileInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid reconciliation request.' } }); return; }
    if (parsed.data.reason !== 'discovery' && req.headers['x-cloudtasks-taskname'] !== parsed.data.taskName) {
      res.status(403).json({ error: { code: 'TASK_IDENTITY_MISMATCH', message: 'Cloud Task identity does not match.' } }); return;
    }
    try {
      await controller.reconcile(parsed.data);
      res.json({ status: 'ok' });
    } catch (error) {
      const safe = publicError(error);
      console.error('[ORCHESTRATOR] reconciliation failed', { code: safe.code });
      res.status(503).json({ error: safe });
    }
  });
}
