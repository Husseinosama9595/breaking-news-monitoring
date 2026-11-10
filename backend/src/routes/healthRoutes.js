import { Router } from 'express';
import { databaseIsReady } from '../config/database.js';
import { redisStatus } from '../config/redis.js';

const router = Router();

router.get('/live', (_req, res) => res.json({ status: 'ok' }));

router.get('/ready', (_req, res) => {
  const mongoReady = databaseIsReady();
  const redis = redisStatus();
  const redisDegraded = redis.enabled && !redis.ready;
  // Redis is optional; only MongoDB blocks readiness for the Phase 1 API.
  res.status(mongoReady ? 200 : 503).json({
    status: !mongoReady ? 'not_ready' : redisDegraded ? 'degraded' : 'ready',
    services: {
      mongodb: { required: true, ready: mongoReady },
      redis: { required: false, ...redis },
    },
  });
});

export default router;
