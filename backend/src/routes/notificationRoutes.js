import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { createNotificationController } from '../controllers/notificationController.js';

export function createNotificationRouter(options = {}) {
  const router = Router();
  const controller = createNotificationController(options);
  router.use(requireAdmin);
  router.get('/unread-count', controller.unreadCount);
  router.get('/', controller.list);
  router.patch('/read-all', controller.markAllRead);
  router.patch('/:id/read', controller.markRead);
  return router;
}

export default createNotificationRouter();
