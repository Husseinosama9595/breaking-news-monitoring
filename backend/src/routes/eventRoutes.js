import { Router } from 'express';
import { createEventController } from '../controllers/eventController.js';
import { requireAdmin } from '../middleware/auth.js';

/** Create the authenticated dashboard event stream route. */
export function createEventRouter(options = {}) {
  const router = Router();
  const controller = createEventController(options);
  router.get('/stream', requireAdmin, controller.stream);
  return router;
}

const defaultController = createEventController();
const defaultRouter = Router();
defaultRouter.get('/stream', requireAdmin, defaultController.stream);

/** End process-local SSE responses before the HTTP server waits for graceful close. */
export function closeEventStreams() {
  defaultController.closeAll();
}

export default defaultRouter;
