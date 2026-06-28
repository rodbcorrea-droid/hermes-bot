// =============================================================================
// config/index.js
// Carregamento centralizado das variáveis de ambiente e validação básica.
// =============================================================================

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carrega .env da raiz do projeto
dotenv.config({ path: resolve(__dirname, '..', '.env') });

// ---------------------------------------------------------------------------
// Helper: leitura segura de variáveis com fallback
// ---------------------------------------------------------------------------
const required = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[CONFIG] Variável de ambiente obrigatória ausente: ${key}`);
  }
  return value;
};

const optional = (key, fallback = '') => process.env[key] || fallback;

// ---------------------------------------------------------------------------
// Configuração exportada (objeto congelado para evitar mutação acidental)
// ---------------------------------------------------------------------------
const config = Object.freeze({
  // -- Servidor
  port: parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),
  requestIdHeader: optional('REQUEST_ID_HEADER', 'X-Request-Id'),

  // -- Telegram
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    /**
     * Token secreto opcional configurado no setWebhook do Telegram.
     * Se definido, todos os webhooks devem trazer o header
     * X-Telegram-Bot-Api-Secret-Token com este valor.
     */
    webhookSecretToken: optional('TELEGRAM_WEBHOOK_SECRET_TOKEN', ''),
    /**
     * Retorna a URL base da API de Bots do Telegram.
     * @returns {string} URL base com token
     */
    get apiBaseUrl() {
      return `https://api.telegram.org/bot${this.botToken}`;
    },
  },

  // -- Bitrix24
  bitrix24: {
    domain: required('BITRIX24_DOMAIN'),
    userId: required('BITRIX24_USER_ID'),
    webhookToken: required('BITRIX24_WEBHOOK_TOKEN'),
    openChannelId: parseInt(optional('BITRIX24_OPEN_CHANNEL_ID', '1'), 10),
    operatorAliceId: parseInt(optional('BITRIX24_OPERATOR_ALICE_ID', '1'), 10),
    // Campo customizado de CPF no Bitrix24 — descobrir via crm.contact.fields
    // Padrão usual: UF_CRM_<ID numerico>. Default placeholder.
    cpfCustomField: optional('BITRIX24_CPF_CUSTOM_FIELD', 'UF_CRM_CPF'),
    // Estágio/funil padrão para novos negócios criados pelo bot
    dealCategoryId: parseInt(optional('BITRIX24_DEAL_CATEGORY_ID', '0'), 10),
    dealStageNew: optional('BITRIX24_DEAL_STAGE_NEW', 'NEW'),
    // Link público de agendamento (Resource Booking)
    bookingSlug: optional('BITRIX24_BOOKING_SLUG', 'booking'),
    /**
     * Retorna a URL base da API REST do Bitrix24 (webhook).
     * @returns {string} URL base do webhook
     */
    get restBaseUrl() {
      return `https://${this.domain}/rest/${this.userId}/${this.webhookToken}`;
    },
    get bookingUrl() {
      return `https://${this.domain}/pub/${this.bookingSlug}/`;
    },
  },

  // -- Hermes IA
  hermesAI: {
    provider: optional('HERMES_AI_PROVIDER', 'openai'),
    apiKey: optional('HERMES_AI_API_KEY', ''),
    model: optional('HERMES_AI_MODEL', 'gpt-4o-mini'),
    baseUrl: optional('HERMES_AI_BASE_URL', ''),
    // Nem todo provedor OpenAI-compatível suporta response_format json_object.
    // Setar false para Ollama, vLLM, LM Studio, etc.
    supportsJsonMode: optional('HERMES_AI_SUPPORTS_JSON_MODE', 'true') === 'true',
    // Timeout em ms para chamadas de IA
    timeoutMs: parseInt(optional('HERMES_AI_TIMEOUT_MS', '8000'), 10),
  },

  // -- Sessões
  session: {
    // 'memory' | 'redis' (futuro)
    backend: optional('SESSION_BACKEND', 'memory'),
    ttlMinutes: parseInt(optional('SESSION_TTL_MINUTES', '30'), 10),
    historyLimit: parseInt(optional('SESSION_HISTORY_LIMIT', '50'), 10),
  },

  // -- Rate limiting
  rateLimit: {
    // Webhook do Telegram NÃO deve ser rate-limited agressivamente
    // (Telegram reenvia com retry-after e podemos perder updates).
    telegramWindowMs: parseInt(optional('RATE_LIMIT_TG_WINDOW_MS', '60000'), 10),
    telegramMax: parseInt(optional('RATE_LIMIT_TG_MAX', '600'), 10),
    // Bitrix24 webhook (eventos reversos) — mais restritivo
    bitrix24WindowMs: parseInt(optional('RATE_LIMIT_BX_WINDOW_MS', '60000'), 10),
    bitrix24Max: parseInt(optional('RATE_LIMIT_BX_MAX', '60'), 10),
  },

  // -- Retry (chamadas HTTP para Bitrix24 / IA)
  retry: {
    maxAttempts: parseInt(optional('RETRY_MAX_ATTEMPTS', '3'), 10),
    baseDelayMs: parseInt(optional('RETRY_BASE_DELAY_MS', '500'), 10),
  },

  // -- Logging
  log: {
    level: optional('LOG_LEVEL', 'info'),
    // 'plain' | 'json' (json = estruturado pino-style)
    format: optional('LOG_FORMAT', 'plain'),
  },

  // -- Contingência
  fallback: {
    phone: optional('FALLBACK_PHONE', '(65) 3052-5278'),
  },
});

export default config;
