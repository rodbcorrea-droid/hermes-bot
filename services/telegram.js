// =============================================================================
// services/telegram.js
// Métodos puros para interação com a API de Bots do Telegram (HTTP).
// NENHUM framework de terceiros (Telegraf, etc.) — apenas axios.
// =============================================================================

import axios from 'axios';
import config from '../config/index.js';
import { withRetry } from '../utils/retry.js';

// ---------------------------------------------------------------------------
// Cliente HTTP reutilizável (keep-alive, timeout)
// ---------------------------------------------------------------------------
const telegramClient = axios.create({
  baseURL: config.telegram.apiBaseUrl,
  timeout: 10_000, // 10 segundos
  headers: { 'Content-Type': 'application/json' },
});

// ---------------------------------------------------------------------------
// Tipos de parse_mode suportados
// ---------------------------------------------------------------------------
const PARSE_MODES = Object.freeze({
  HTML: 'HTML',
  MARKDOWN: 'MarkdownV2',
  NONE: null,
});

// ---------------------------------------------------------------------------
// Verificação do secret token do webhook (proteção contra forjamento)
// ---------------------------------------------------------------------------

/**
 * Verifica se o header X-Telegram-Bot-Api-Secret-Token é válido.
 * Se TELEGRAM_WEBHOOK_SECRET_TOKEN não estiver configurado, aceita qualquer.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isValidWebhookSecret(req) {
  const expected = config.telegram.webhookSecretToken;
  if (!expected) return true; // Sem secret configurado = sem verificação
  const got = req.get('X-Telegram-Bot-Api-Secret-Token');
  return !!got && got === expected;
}

// ---------------------------------------------------------------------------
// Helper: chama a API do Telegram com retry (erros 5xx e timeouts)
// ---------------------------------------------------------------------------
async function tgCall(path, payload, opts = {}) {
  return withRetry(
    async () => {
      const { data } = await telegramClient.post(path, payload, {
        timeout: opts.timeoutMs,
        // Retry só em 5xx e erros de rede (não em 4xx)
        validateStatus: (s) => s < 500,
      });
      if (data && data.ok === false) {
        const err = new Error(`[Telegram] ${data.description || 'API error'}`);
        err.tgError = data;
        throw err;
      }
      return data;
    },
    {
      maxAttempts: 3,
      baseDelayMs: 400,
      label: `telegram.${path}`,
      shouldRetry: (err) => {
        // Não retentar erros 4xx do Telegram
        if (err.response && err.response.status < 500) return false;
        return true;
      },
    }
  );
}

// ---------------------------------------------------------------------------
// API: enviar mensagem de texto simples
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem de texto simples para um chat do Telegram.
 * @param {number|string} chatId
 * @param {string} text - Texto no formato HTML ou puro
 * @param {object} [opts={}]
 * @param {string} [opts.parseMode='HTML'] - 'HTML' | 'MarkdownV2' | null
 * @param {object} [opts.replyMarkup] - Objeto de inline_keyboard ou reply_keyboard
 * @returns {Promise<object>} Resposta da API do Telegram
 */
export async function sendMessage(chatId, text, opts = {}) {
  const { parseMode = 'HTML', replyMarkup = null } = opts;

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };

  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  return tgCall('/sendMessage', payload);
}

// ---------------------------------------------------------------------------
// API: enviar mensagem com teclado inline (botões)
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem com botões inline (inline_keyboard).
 * @param {number|string} chatId
 * @param {string} text
 * @param {Array<Array<{text: string, callback_data: string}>>} buttons
 * @param {object} [opts={}]
 * @returns {Promise<object>}
 */
export async function sendInlineKeyboard(chatId, text, buttons, opts = {}) {
  return sendMessage(chatId, text, {
    ...opts,
    replyMarkup: { inline_keyboard: buttons },
  });
}

// ---------------------------------------------------------------------------
// API: responder callback_query
// ---------------------------------------------------------------------------

/**
 * Responde a um callback_query do Telegram (remove loading do botão).
 * @param {string} callbackQueryId
 * @param {object} [opts={}]
 * @param {string} [opts.text]
 * @param {boolean} [opts.showAlert=false]
 * @returns {Promise<void>}
 */
export async function answerCallbackQuery(callbackQueryId, opts = {}) {
  const { text = '', showAlert = false } = opts;
  const payload = { callback_query_id: callbackQueryId };

  if (text) {
    payload.text = text;
    payload.show_alert = showAlert;
  }

  await tgCall('/answerCallbackQuery', payload);
}

// ---------------------------------------------------------------------------
// API: editar mensagem existente
// ---------------------------------------------------------------------------

/**
 * Edita o texto e/ou teclado de uma mensagem já enviada.
 * @param {number|string} chatId
 * @param {number} messageId
 * @param {string} newText
 * @param {Array} [buttons=null]
 * @returns {Promise<object>}
 */
export async function editMessageText(chatId, messageId, newText, buttons = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: newText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (buttons) {
    payload.reply_markup = { inline_keyboard: buttons };
  }

  return tgCall('/editMessageText', payload);
}

// ---------------------------------------------------------------------------
// API: solicitar contato do usuário
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem com botão que solicita o contato do usuário.
 * @param {number|string} chatId
 * @param {string} prompt
 * @returns {Promise<object>}
 */
export async function requestContact(chatId, prompt) {
  return sendMessage(chatId, prompt, {
    replyMarkup: {
      keyboard: [
        [{ text: '📱 Compartilhar meu número', request_contact: true }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
    parseMode: 'HTML',
  });
}

// ---------------------------------------------------------------------------
// API: remover teclado customizado
// ---------------------------------------------------------------------------

/**
 * Remove o teclado customizado da tela do usuário.
 * @param {number|string} chatId
 * @param {string} [text='⌨ Teclado recolhido.']
 * @returns {Promise<object>}
 */
export async function removeKeyboard(chatId, text = '⌨ Teclado recolhido.') {
  return sendMessage(chatId, text, {
    replyMarkup: { remove_keyboard: true },
    parseMode: 'HTML',
  });
}

// ---------------------------------------------------------------------------
// API: configurar webhook (com secret_token)
// ---------------------------------------------------------------------------

/**
 * Configura o webhook do Telegram no endpoint informado, incluindo secret_token.
 * @param {string} webhookUrl - URL pública HTTPS do webhook
 * @returns {Promise<object>}
 */
export async function setWebhook(webhookUrl) {
  const payload = {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query', 'contact'],
    drop_pending_updates: true,
  };

  if (config.telegram.webhookSecretToken) {
    payload.secret_token = config.telegram.webhookSecretToken;
  }

  return tgCall('/setWebhook', payload);
}

// ---------------------------------------------------------------------------
// API: extrair informações relevantes do payload do Telegram
// ---------------------------------------------------------------------------

/**
 * Extrai o objeto de chat e o texto/mensagem do payload recebido via webhook.
 * @param {object} body
 * @returns {object}
 */
export function extractPayload(body) {
  // Callback query (botão inline pressionado)
  if (body.callback_query) {
    const cb = body.callback_query;
    return {
      chatId: cb.message?.chat?.id ?? cb.from?.id ?? null,
      text: null,
      contact: null,
      callbackQueryId: cb.id || null,
      callbackData: cb.data || null,
      messageId: cb.message?.message_id || null,
      firstName: cb.from?.first_name || '',
      lastName: cb.from?.last_name || '',
      username: cb.from?.username || '',
    };
  }

  // Mensagem normal (texto, contato, etc.)
  if (body.message) {
    const msg = body.message;
    return {
      chatId: msg.chat?.id ?? null,
      text: msg.text || null,
      contact: msg.contact || null,
      callbackQueryId: null,
      callbackData: null,
      messageId: msg.message_id || null,
      firstName: msg.from?.first_name || '',
      lastName: msg.from?.last_name || '',
      username: msg.from?.username || '',
    };
  }

  // Payload não reconhecido
  return {
    chatId: null,
    text: null,
    contact: null,
    callbackQueryId: null,
    callbackData: null,
    messageId: null,
    firstName: '',
    lastName: '',
    username: '',
  };
}

export { PARSE_MODES };
