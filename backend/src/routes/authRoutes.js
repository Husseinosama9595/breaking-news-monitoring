import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createAdminToken, requireAdmin, verifyAdminCredentials } from '../middleware/auth.js';

const router = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string'
      || username.length > 100 || password.length > 256
      || !verifyAdminCredentials(username, password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  return res.json({ accessToken: createAdminToken(), tokenType: 'Bearer', expiresIn: 28800 });
});

router.get('/session', requireAdmin, (_req, res) => res.json({ authenticated: true }));

export default router;
