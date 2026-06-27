// =============================================================================
// tests/retry.test.js — testes para utils/retry.js
// =============================================================================

import './setup.js';
import { describe, it, expect } from 'vitest';
import { withRetry } from '../utils/retry.js';

describe('withRetry', () => {
  it('retorna resultado na primeira tentativa quando sucesso', async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  it('retenta quando shouldRetry retorna true e eventualmente tem sucesso', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      },
      { maxAttempts: 5, baseDelayMs: 10, shouldRetry: () => true }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('lança erro quando maxAttempts é atingido', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('always fails');
        },
        { maxAttempts: 3, baseDelayMs: 10 }
      )
    ).rejects.toThrow('always fails');
    expect(attempts).toBe(3);
  });

  it('não retenta quando shouldRetry retorna false', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('4xx error');
        },
        { maxAttempts: 5, baseDelayMs: 10, shouldRetry: () => false }
      )
    ).rejects.toThrow('4xx error');
    expect(attempts).toBe(1);
  });

  it('aceita label para logging', async () => {
    const result = await withRetry(async () => 'done', { label: 'test-op' });
    expect(result).toBe('done');
  });
});
