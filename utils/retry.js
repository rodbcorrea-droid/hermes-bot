// =============================================================================
// utils/retry.js
// Retry com backoff exponencial + jitter para chamadas HTTP transitórias.
// =============================================================================

import config from '../config/index.js';

const DEFAULT_MAX = config.retry.maxAttempts;
const DEFAULT_BASE = config.retry.baseDelayMs;

/**
 * Executa fn com retry exponencial + jitter.
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.baseDelayMs=500]
 * @param {(err: Error, attempt: number) => boolean} [opts.shouldRetry]
 *   Retorna true para retry. Default: sempre.
 * @param {string} [opts.label]
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(fn, opts = {}) {
  const max = opts.maxAttempts ?? DEFAULT_MAX;
  const base = opts.baseDelayMs ?? DEFAULT_BASE;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  const label = opts.label ?? 'operation';

  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= max || !shouldRetry(err, attempt)) {
        throw err;
      }
      const delay = base * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
