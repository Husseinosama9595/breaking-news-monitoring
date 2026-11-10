import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { createCountryController } from '../controllers/countryController.js';

export function createCountryRouter(options = {}) {
  const router = Router();
  const controller = createCountryController(options);
  router.use(requireAdmin);
  router.get('/catalog', controller.catalog);
  router.get('/', controller.list);
  return router;
}

export default createCountryRouter();
