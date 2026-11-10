import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { createAccountController } from '../controllers/accountController.js';

/** Create the protected account router; dependencies are injectable for service-free tests. */
export function createAccountRouter(options = {}) {
  const router = Router();
  const controller = createAccountController(options);
  router.use(requireAdmin);
  router.get('/', controller.list);
  router.post('/', controller.create);
  router.get('/:id', controller.getById);
  router.patch('/:id/enable', controller.enable);
  router.patch('/:id/disable', controller.disable);
  router.patch('/:id', controller.update);
  return router;
}

export default createAccountRouter();
