// =============================================================================
// middleware/session.js
// Gerenciamento de estado das conversas (máquina de estados em memória).
// Em produção, substituir por Redis ou banco de dados persistente.
// =============================================================================

// ---------------------------------------------------------------------------
// Constantes dos estados da máquina de conversa
// ---------------------------------------------------------------------------
export const State = Object.freeze({
  IDLE: 'IDLE',
  AWAITING_CPF: 'AWAITING_CPF',
  AWAITING_NAME: 'AWAITING_NAME',
  AUTHENTICATED: 'AUTHENTICATED',
  AWAITING_STATUS_CPF: 'AWAITING_STATUS_CPF',
  AWAITING_CALLBACK_DETAILS: 'AWAITING_CALLBACK_DETAILS',
  HANDOFF: 'HANDOFF',
});

// ---------------------------------------------------------------------------
// Tempo de vida da sessão (30 minutos sem atividade = expira)
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Store em memória: Map<chatId, Session>
// ---------------------------------------------------------------------------
const sessions = new Map();

// ---------------------------------------------------------------------------
// Limpeza periódica de sessões expiradas (a cada 5 minutos)
// ---------------------------------------------------------------------------
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(chatId);
    }
  }
}, 5 * 60 * 1000);

// Impede que o intervalo mantenha o processo vivo (permite graceful shutdown)
if (cleanupInterval.unref) cleanupInterval.unref();

// ---------------------------------------------------------------------------
// Factory: cria uma nova sessão limpa
// ---------------------------------------------------------------------------
function createSession(chatId, overrides = {}) {
  return {
    chatId,
    state: State.IDLE,
    phone: null,
    cpf: null,
    name: null,
    crmContactId: null,
    crmDealId: null,
    history: [],               // [{ role, content, timestamp }]
    lastActivity: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// API pública do gerenciador de sessões
// ---------------------------------------------------------------------------

/**
 * Obtém uma sessão existente ou cria uma nova para o chatId informado.
 * @param {number|string} chatId - ID do chat no Telegram
 * @returns {object} Sessão ativa
 */
export function getSession(chatId) {
  let session = sessions.get(chatId);
  if (!session) {
    session = createSession(chatId);
    sessions.set(chatId, session);
  }
  session.lastActivity = Date.now();
  return session;
}

/**
 * Atualiza o estado e opcionalmente outros campos da sessão.
 * @param {number|string} chatId
 * @param {string} newState - Um dos valores de State
 * @param {object} [fields={}] - Campos adicionais para merge na sessão
 */
export function updateSession(chatId, newState, fields = {}) {
  const session = getSession(chatId);
  session.state = newState;
  Object.assign(session, fields, { lastActivity: Date.now() });
}

/**
 * Adiciona uma entrada ao histórico de mensagens da sessão.
 * @param {number|string} chatId
 * @param {string} role - 'user' | 'bot' | 'system'
 * @param {string} content
 */
export function appendHistory(chatId, role, content) {
  const session = getSession(chatId);
  session.history.push({ role, content, timestamp: Date.now() });
  // Mantém apenas as últimas 50 mensagens para não inflar memória
  if (session.history.length > 50) {
    session.history = session.history.slice(-50);
  }
}

/**
 * Remove a sessão (ex: após handoff concluído).
 * @param {number|string} chatId
 */
export function deleteSession(chatId) {
  sessions.delete(chatId);
}

/**
 * Retorna o número de sessões ativas (útil para monitoramento).
 * @returns {number}
 */
export function activeSessionCount() {
  return sessions.size;
}

/**
 * Destrói o intervalo de limpeza (útil para testes ou shutdown).
 */
export function destroySessionCleanup() {
  clearInterval(cleanupInterval);
}
