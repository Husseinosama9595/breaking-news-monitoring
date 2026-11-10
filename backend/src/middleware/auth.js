import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/environment.js';

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyAdminCredentials(username, password) {
  return constantTimeEqual(username, env.adminUsername)
    && constantTimeEqual(password, env.adminPassword);
}

export function createAdminToken() {
  return jwt.sign({ role: 'admin' }, env.jwtSecret, { subject: 'admin', expiresIn: '8h' });
}

export function requireAdmin(req, res, next) {
  const authorization = req.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match) return res.status(401).json({ error: 'Authentication required' });

  try {
    const token = jwt.verify(match[1], env.jwtSecret);
    if (token.role !== 'admin' || token.sub !== 'admin') {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    req.admin = { subject: token.sub };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired authentication token' });
  }
}
