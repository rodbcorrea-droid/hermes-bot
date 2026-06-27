// =============================================================================
// utils/requestId.js
// Middleware que gera (ou reutiliza) um UUID por requisição e anexa ao req.
// =============================================================================

import crypto from 'crypto';
import config from '../config/index.js';

/**
 * Express middleware — gera requestId único por requisição.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Function} next
 */
export function requestIdMiddleware(req, res, next) {
  const header = config.requestIdHeader;
  const incoming = header && req.get(header);
  const id = incoming || crypto.randomUUID();
  req.requestId = id;
  res.set(header, id);
  next();
}

/**
 * Recupera requestId de um req (ou retorna undefined).
 * @param {import('express').Request} req
 * @returns {string|undefined}
 */
export function getRequestId(req) {
  return req?.requestId;
}
