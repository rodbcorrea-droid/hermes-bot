// =============================================================================
// services/telegram.js
// Métodos puros para interação com a API de Bots do Telegram (HTTP).
// NENHUM framework de terceiros (Telegraf, etc.) — apenas axios.
// =============================================================================

import axios from 'axios';
import config from '../config/index.js';

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

  const { data } = await telegramClient.post('/sendMessage', payload);
  return data;
}

// ---------------------------------------------------------------------------
// API: enviar mensagem com teclado inline (botões)
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem com botões inline (inline_keyboard).
 * Cada botão pode ter callback_data para ser processado via callback_query.
 *
 * @param {number|string} chatId
 * @param {string} text
 * @param {Array<Array<{text: string, callback_data: string}>>} buttons
 *   Matriz 2D: cada sub-array é uma linha de botões.
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
// API: responder callback_query (para evitar loading infinito no cliente)
// ---------------------------------------------------------------------------

/**
 * Responde a um callback_query do Telegram (obrigatório para remover o
 * estado de "loading" do botão pressionado pelo usuário).
 *
 * @param {string} callbackQueryId - ID do callback_query recebido
 * @param {object} [opts={}]
 * @param {string} [opts.text] - Texto de toast/alert (opcional)
 * @param {boolean} [opts.showAlert=false] - Se true, mostra popup em vez de toast
 * @returns {Promise<void>}
 */
export async function answerCallbackQuery(callbackQueryId, opts = {}) {
  const { text = '', showAlert = false } = opts;
  const payload = { callback_query_id: callbackQueryId };

  if (text) {
    payload.text = text;
    payload.show_alert = showAlert;
  }

  await telegramClient.post('/answerCallbackQuery', payload);
}

// ---------------------------------------------------------------------------
// API: editar mensagem existente (útil para atualizar menus)
// ---------------------------------------------------------------------------

/**
 * Edita o texto e/ou teclado de uma mensagem já enviada.
 * @param {number|string} chatId
 * @param {number} messageId
 * @param {string} newText
 * @param {Array} [buttons=null] - Novo teclado inline (ou null para manter)
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

  const { data } = await telegramClient.post('/editMessageText', payload);
  return data;
}

// ---------------------------------------------------------------------------
// API: solicitar contato do usuário (botão "Compartilhar contato")
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem com botão que solicita o contato do usuário.
 * O Telegram exibe um botão nativo "Compartilhar meu número".
 *
 * @param {number|string} chatId
 * @param {string} prompt - Texto explicativo
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
// API: remover teclado customizado (voltar ao normal)
// ---------------------------------------------------------------------------

/**
 * Remove o teclado customizado (reply keyboard) da tela do usuário.
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
// API: extrair informações relevantes do payload do Telegram
// ---------------------------------------------------------------------------

/**
 * Extrai o objeto de chat e o texto/mensagem do payload recebido via webhook.
 * Lida com mensagens de texto, contatos compartilhados, e callback_queries.
 *
 * @param {object} body - Corpo completo do webhook do Telegram
 * @returns {{ chatId: number|null, text: string|null, contact: object|null,
 *             callbackQueryId: string|null, callbackData: string|null,
 *             messageId: number|null, firstName: string, lastName: string,
 *             username: string }}
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
