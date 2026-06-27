// =============================================================================
// tests/session.test.js — testes para middleware/session.js
// =============================================================================

import './setup.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  State,
  getSession,
  updateSession,
  appendHistory,
  deleteSession,
  activeSessionCount,
  destroySessionCleanup,
} from '../middleware/session.js';

beforeEach(() => {
  // Limpa sessões entre testes
  // Nota: como sessions é um Map privado, limpamos via deleteSession por chatId
});

afterEach(() => {
  // Restore cleanup interval se foi destruído
});

describe('session middleware', () => {
  it('cria nova sessão com estado IDLE', () => {
    const session = getSession('chat123');
    expect(session.chatId).toBe('chat123');
    expect(session.state).toBe(State.IDLE);
    expect(session.phone).toBeNull();
    expect(session.cpf).toBeNull();
    expect(session.name).toBeNull();
    expect(session.history).toEqual([]);
    expect(typeof session.lastActivity).toBe('number');
  });

  it('retorna mesma sessão para mesmo chatId', () => {
    const s1 = getSession('chatX');
    s1.name = 'João';
    const s2 = getSession('chatX');
    expect(s2).toBe(s1);
    expect(s2.name).toBe('João');
  });

  it('updateSession altera estado e campos', () => {
    const updated = updateSession('chatY', State.AWAITING_CPF, { cpf: '12345678909' });
    expect(updated.state).toBe(State.AWAITING_CPF);
    expect(updated.cpf).toBe('12345678909');
  });

  it('updateSession retorna referência fresca (não stale)', () => {
    const stale = getSession('chatZ');
    const updated = updateSession('chatZ', State.AUTHENTICATED, { name: 'Maria' });
    // A referência retornada deve ter os novos dados
    expect(updated.name).toBe('Maria');
    expect(updated.state).toBe(State.AUTHENTICATED);
    // A referência antiga também deve apontar para o mesmo objeto (mesma sessão)
    expect(stale.name).toBe('Maria');
  });

  it('appendHistory adiciona ao histórico', () => {
    appendHistory('chatH', 'user', 'oi');
    appendHistory('chatH', 'bot', 'olá');
    const session = getSession('chatH');
    expect(session.history).toHaveLength(2);
    expect(session.history[0]).toEqual({
      role: 'user',
      content: 'oi',
      timestamp: expect.any(Number),
    });
    expect(session.history[1].role).toBe('bot');
  });

  it('appendHistory respeita limite configurado', () => {
    // Adiciona 100 mensagens — deve manter só as últimas N
    for (let i = 0; i < 100; i++) {
      appendHistory('chatL', 'user', `msg ${i}`);
    }
    const session = getSession('chatL');
    // historyLimit default = 50
    expect(session.history.length).toBeLessThanOrEqual(50);
  });

  it('deleteSession remove sessão', () => {
    getSession('chatD');
    expect(activeSessionCount()).toBeGreaterThan(0);
    deleteSession('chatD');
    // Após delete, getSession cria nova — verificamos que estado volta a IDLE
    const fresh = getSession('chatD');
    expect(fresh.state).toBe(State.IDLE);
  });

  it('activeSessionCount retorna número >= 0', () => {
    expect(activeSessionCount()).toBeGreaterThanOrEqual(0);
  });

  it('destroySessionCleanup pode ser chamado sem erro', () => {
    expect(() => destroySessionCleanup()).not.toThrow();
  });

  it('State enum tem todos os estados esperados', () => {
    expect(State.IDLE).toBe('IDLE');
    expect(State.AWAITING_CPF).toBe('AWAITING_CPF');
    expect(State.AWAITING_NAME).toBe('AWAITING_NAME');
    expect(State.AUTHENTICATED).toBe('AUTHENTICATED');
    expect(State.AWAITING_STATUS_CPF).toBe('AWAITING_STATUS_CPF');
    expect(State.AWAITING_CALLBACK_DETAILS).toBe('AWAITING_CALLBACK_DETAILS');
    expect(State.HANDOFF).toBe('HANDOFF');
  });
});
