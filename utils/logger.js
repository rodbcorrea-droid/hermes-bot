// =============================================================================
// utils/logger.js
// Logging estruturado — suporta modo 'plain' (console) e 'json' (pino-style).
// Cada log carrega requestId quando disponível (propagado pelo middleware).
// =============================================================================

import config from '../config/index.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const MIN_LEVEL = LEVELS[config.log.level] ?? LEVELS.info;
const IS_JSON = config.log.format === 'json';

function formatPlain(level, msg, meta, requestId) {
  const ts = new Date().toISOString();
  const rid = requestId ? `[${requestId}] ` : '';
  const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level.toUpperCase()} ${rid}${msg}${metaStr}`;
}

function formatJson(level, msg, meta, requestId) {
  return JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg,
    ...(requestId ? { requestId } : {}),
    ...(meta || {}),
  });
}

/**
 * Cria um logger vinculado a um requestId opcional.
 * @param {string} [requestId]
 * @returns {{ debug, info, warn, error, child }}
 */
export function createLogger(requestId) {
  const log = (level, msg, meta) => {
    if (LEVELS[level] < MIN_LEVEL) return;
    const line = IS_JSON
      ? formatJson(level, msg, meta, requestId)
      : formatPlain(level, msg, meta, requestId);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, meta) => log('debug', m, meta),
    info: (m, meta) => log('info', m, meta),
    warn: (m, meta) => log('warn', m, meta),
    error: (m, meta) => log('error', m, meta),
    /**
     * Cria um sub-logger herdando o mesmo requestId.
     * @param {string} component
     */
    child: (component) =>
      createLogger(requestId).withComponent?.(component) ?? createLogger(requestId),
  };
}

/**
 * Logger global sem requestId (para startup/shutdown).
 */
export const logger = createLogger();
