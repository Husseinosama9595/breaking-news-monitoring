import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { createPostController } from '../controllers/postController.js';

/** Create the protected, read-only posts router. */
export function createPostRouter(options = {}) {
  const router = Router();
  const controller = createPostController(options);
  router.use(requireAdmin);
  router.get('/', controller.list);
  return router;
}

export default createPostRouter();
