// =============================================================================
// tests/logger.test.js — testes para utils/logger.js
// =============================================================================

import './setup.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../utils/logger.js';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('createLogger retorna objeto com métodos debug/info/warn/error/child', () => {
    const log = createLogger('req-1');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.child).toBe('function');
  });

  it('log info chama console.log', () => {
    const log = createLogger('req-2');
    log.info('test message', { foo: 'bar' });
    expect(console.log).toHaveBeenCalled();
    const line = console.log.mock.calls[0][0];
    expect(line).toContain('test message');
    expect(line).toContain('req-2');
  });

  it('log error chama console.error', () => {
    const log = createLogger('req-3');
    log.error('boom');
    expect(console.error).toHaveBeenCalled();
  });

  it('log warn chama console.warn', () => {
    const log = createLogger('req-4');
    log.warn('careful');
    expect(console.warn).toHaveBeenCalled();
  });

  it('respeita nível mínimo (default info — debug suprimido)', () => {
    const log = createLogger('req-5');
    log.debug('should not log');
    expect(console.log).not.toHaveBeenCalled();
  });
});
