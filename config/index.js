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

  // -- Telegram
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
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
    /**
     * Retorna a URL base da API REST do Bitrix24 (webhook).
     * @returns {string} URL base do webhook
     */
    get restBaseUrl() {
      return `https://${this.domain}/rest/${this.userId}/${this.webhookToken}`;
    },
  },

  // -- Hermes IA
  hermesAI: {
    provider: optional('HERMES_AI_PROVIDER', 'openai'),
    apiKey: optional('HERMES_AI_API_KEY', ''),
    model: optional('HERMES_AI_MODEL', 'gpt-4o-mini'),
    baseUrl: optional('HERMES_AI_BASE_URL', ''),
  },

  // -- Contingência
  fallback: {
    phone: optional('FALLBACK_PHONE', '(65) 99679-4931'),
  },
});

export default config;
