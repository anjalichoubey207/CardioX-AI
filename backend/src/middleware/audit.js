import { memDb, isMemoryDb, getDbPool } from '../config/database.js';

export function auditLogger(req, res, next) {
  const start = Date.now();
  
  res.on('finish', () => {
    // Only log mutating healthcare operations or authentication
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!isMutating && !req.path.includes('/auth')) return;

    const logEntry = {
      user_id: req.user ? req.user.id : null,
      action: `${req.method} ${req.originalUrl || req.url}`,
      resource_type: req.baseUrl ? req.baseUrl.replace('/api/v1/', '') : 'system',
      resource_id: (req.params && req.params.id) ? req.params.id : null,
      ip_address: req.ip || req.connection.remoteAddress,
      user_agent: req.headers['user-agent'] || 'unknown',
      details: {
        statusCode: res.statusCode,
        durationMs: Date.now() - start
      },
      created_at: new Date().toISOString()
    };

    if (isMemoryDb()) {
      memDb.audit_logs.push(logEntry);
    } else {
      const pool = getDbPool();
      if (pool) {
        pool.query(
          'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, ip_address, user_agent, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            logEntry.user_id,
            logEntry.action,
            logEntry.resource_type,
            logEntry.resource_id,
            logEntry.ip_address,
            logEntry.user_agent,
            JSON.stringify(logEntry.details)
          ]
        ).catch(err => console.error('Audit log write error:', err.message));
      }
    }
  });

  next();
}
