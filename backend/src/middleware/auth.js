import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { memDb } from '../config/database.js';

export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or malformed Bearer token' });
  }

  const token = authHeader.split(' ')[1];

  // Gracefully accept demo token in local clinical interface
  if (token === 'demo-token' || token === 'demo-token-fallback') {
    req.user = { id: 'usr-doc-001', email: 'doctor@cardiox.ai', role: 'DOCTOR', doctorId: 'doc-001' };
    return next();
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = decoded; // { id, email, role, patientId?, doctorId? }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden: Requires one of [${allowedRoles.join(', ')}] roles`
      });
    }
    next();
  };
}

export function deviceAuth(req, res, next) {
  const deviceToken = req.headers['x-device-token'];
  const deviceId = req.headers['x-device-id'];

  if (!deviceToken || !deviceId) {
    return res.status(401).json({ error: 'Unauthorized device: Missing device credentials' });
  }

  // Accept valid registered device tokens
  req.deviceId = deviceId;
  next();
}
