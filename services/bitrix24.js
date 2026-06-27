// =============================================================================
// services/bitrix24.js
// Integração com a API REST do Bitrix24: CRM, Open Channels, Mensagens.
// Todos os métodos utilizam o padrão de Webhook REST do Bitrix24:
//   POST https://{domain}/rest/{user_id}/{webhook_token}/{method}
// =============================================================================

import axios from 'axios';
import config from '../config/index.js';
import { withRetry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Cliente HTTP reutilizável para o Bitrix24
// ---------------------------------------------------------------------------
const bxClient = axios.create({
  baseURL: config.bitrix24.restBaseUrl,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

// ---------------------------------------------------------------------------
// Helper: valida resposta da API Bitrix24
// ---------------------------------------------------------------------------

/**
 * Verifica se a resposta da API Bitrix24 contém erro e lança exceção amigável.
 * @param {object} response - Axios response data
 * @param {string} operation - Nome da operação (para logging)
 * @returns {object} response.data.result
 */
function unwrapResult(response, operation) {
  const { result, error } = response;
  if (error) {
    const err = new Error(
      `[Bitrix24] Erro em ${operation}: ${error.error_name || error} — ${error.error_description || ''}`
    );
    err.bxError = error;
    throw err;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helper: chamada com retry (5xx e timeouts são transitórios)
// ---------------------------------------------------------------------------
async function bxCall(method, payload = {}, opts = {}) {
  return withRetry(
    async () => {
      const { data } = await bxClient.post(method, payload, {
        timeout: opts.timeoutMs,
      });
      return unwrapResult(data, method);
    },
    {
      maxAttempts: 3,
      baseDelayMs: 600,
      label: `bitrix24.${method}`,
      shouldRetry: (err) => {
        // Não retentar erros 4xx (400/401/403/404) — são determinísticos
        if (err.response && err.response.status < 500) return false;
        // Erros de negócio do Bitrix24 (bxError) também não retentar
        if (err.bxError) return false;
        return true;
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Helper: normaliza telefone para busca no CRM
// ---------------------------------------------------------------------------

/**
 * Retorna lista de variações de telefone para buscar no Bitrix24.
 * Bitrix24 às vezes armazena com DDI (55), com zero inicial, ou só DDD+numero.
 * @param {string} phone
 * @returns {string[]}
 */
function phoneVariants(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return [];
  const variants = new Set([clean]);
  // Com DDI 55
  if (clean.length === 11) variants.add(`55${clean}`);
  if (clean.length === 10) variants.add(`55${clean}`);
  // Sem DDI (se tem 13 dígitos, remove 55)
  if (clean.length === 13 && clean.startsWith('55')) variants.add(clean.slice(2));
  // Com zero inicial (formato antigo)
  if (clean.length === 11) variants.add(`0${clean}`);
  // Só últimos 9 dígitos (sem DDD)
  if (clean.length >= 9) variants.add(clean.slice(-9));
  // Só últimos 10 (com nono dígito)
  if (clean.length >= 10) variants.add(clean.slice(-10));
  return [...variants];
}

// ---------------------------------------------------------------------------
// 1. CRM — Busca de Contatos
// ---------------------------------------------------------------------------

/**
 * Busca contatos no CRM por CPF e/ou telefone.
 * Usa o filtro OR do Bitrix24 com sintaxe correta (chaves numéricas).
 * @param {object} filters
 * @param {string} [filters.cpf]
 * @param {string} [filters.phone]
 * @returns {Promise<Array<object>>}
 */
export async function findContactByCpfOrPhone({ cpf, phone } = {}) {
  const orClauses = [];

  if (cpf) {
    orClauses.push({ [config.bitrix24.cpfCustomField]: cpf });
  }

  if (phone) {
    for (const variant of phoneVariants(phone)) {
      orClauses.push({ PHONE: variant });
    }
  }

  if (orClauses.length === 0) return [];

  // Sintaxe correta: LOGIC: 'OR' + chaves numéricas "0", "1", "2", ...
  const filter = { LOGIC: 'OR' };
  orClauses.forEach((clause, i) => {
    filter[String(i)] = clause;
  });

  const result = await bxCall('/crm.contact.list.json', {
    filter,
    select: ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL', config.bitrix24.cpfCustomField],
  });

  return Array.isArray(result) ? result : [];
}

// ---------------------------------------------------------------------------
// 2. CRM — Busca de Leads
// ---------------------------------------------------------------------------

/**
 * Busca leads no CRM por CPF e/ou telefone.
 * @param {object} filters
 * @param {string} [filters.cpf]
 * @param {string} [filters.phone]
 * @returns {Promise<Array<object>>}
 */
export async function findLeadByCpfOrPhone({ cpf, phone } = {}) {
  const orClauses = [];

  if (cpf) {
    orClauses.push({ [config.bitrix24.cpfCustomField]: cpf });
  }

  if (phone) {
    for (const variant of phoneVariants(phone)) {
      orClauses.push({ PHONE: variant });
    }
  }

  if (orClauses.length === 0) return [];

  const filter = { LOGIC: 'OR' };
  orClauses.forEach((clause, i) => {
    filter[String(i)] = clause;
  });

  const result = await bxCall('/crm.lead.list.json', {
    filter,
    select: ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'STATUS_ID', config.bitrix24.cpfCustomField],
  });

  return Array.isArray(result) ? result : [];
}

// ---------------------------------------------------------------------------
// 3. CRM — Criar novo Lead
// ---------------------------------------------------------------------------

/**
 * Cria um novo Lead no funil inicial da Brandão Correa.
 * @param {object} leadData
 * @param {string} leadData.name
 * @param {string} [leadData.phone]
 * @param {string} [leadData.cpf]
 * @returns {Promise<object>}
 */
export async function createLead({ name, phone, cpf } = {}) {
  const fields = {
    TITLE: name || 'Lead via Telegram',
    NAME: name || 'Cliente Telegram',
    SOURCE_ID: 'TELEGRAM',
    SOURCE_DESCRIPTION: 'Captado via Bot Hermes (Telegram)',
    OPENED: 'Y',
  };

  if (phone) fields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'MOBILE' }];
  if (cpf) fields[config.bitrix24.cpfCustomField] = cpf;

  return bxCall('/crm.lead.add.json', { fields });
}

// ---------------------------------------------------------------------------
// 4. CRM — Criar Contato + Negócio
// ---------------------------------------------------------------------------

/**
 * Cria um Contato e um Negócio vinculado no CRM.
 * @param {object} contactData
 * @param {string} contactData.name
 * @param {string} [contactData.phone]
 * @param {string} [contactData.cpf]
 * @returns {Promise<{contactId: number, dealId: number}>}
 */
export async function createContactAndDeal({ name, phone, cpf } = {}) {
  // 4a. Criar Contato
  const contactFields = {
    NAME: name || 'Cliente Telegram',
    SOURCE_ID: 'TELEGRAM',
    SOURCE_DESCRIPTION: 'Captado via Bot Hermes (Telegram)',
    OPENED: 'Y',
  };
  if (phone) contactFields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'MOBILE' }];
  if (cpf) contactFields[config.bitrix24.cpfCustomField] = cpf;

  const contactId = await bxCall('/crm.contact.add.json', { fields: contactFields });

  // 4b. Criar Negócio vinculado ao Contato
  const dealFields = {
    TITLE: `Atendimento Telegram — ${name || 'Novo Cliente'}`,
    CONTACT_ID: contactId,
    CATEGORY_ID: config.bitrix24.dealCategoryId,
    STAGE_ID: config.bitrix24.dealStageNew,
    SOURCE_ID: 'TELEGRAM',
    SOURCE_DESCRIPTION: 'Oportunidade iniciada via Bot Hermes (Telegram)',
    OPENED: 'Y',
  };

  const dealId = await bxCall('/crm.deal.add.json', { fields: dealFields });

  return { contactId, dealId };
}

// ---------------------------------------------------------------------------
// 5. CRM — Buscar Negócios/Processos associados ao Contato
// ---------------------------------------------------------------------------

/**
 * Retorna os negócios (processos) vinculados a um contato.
 * @param {number} contactId
 * @returns {Promise<Array<object>>}
 */
export async function getDealsByContact(contactId) {
  const result = await bxCall('/crm.deal.list.json', {
    filter: { CONTACT_ID: contactId },
    select: ['ID', 'TITLE', 'STAGE_ID', 'DATE_CREATE', 'DATE_MODIFY', 'OPPORTUNITY'],
  });
  return Array.isArray(result) ? result : [];
}

// ---------------------------------------------------------------------------
// 6. CRM — Registrar Atividade "Chamada Solicitada"
// ---------------------------------------------------------------------------

/**
 * Cria uma atividade do tipo "Chamada" com prioridade alta no CRM.
 * @param {object} params
 * @param {number} params.ownerId
 * @param {number} [params.contactId]
 * @param {number} [params.dealId]
 * @param {string} [params.phone]
 * @returns {Promise<object>}
 */
export async function createCallActivity({ ownerId, contactId, dealId, phone } = {}) {
  const fields = {
    OWNER_ID: ownerId,
    TYPE_ID: 2,                     // 2 = Chamada (Call)
    SUBJECT: 'Solicitação de Chamada — Cliente Telegram',
    DESCRIPTION: [
      'Cliente solicitou receber uma ligação via Bot Hermes (Telegram).',
      phone ? `Telefone informado: ${phone}` : 'Telefone: verificar cadastro do contato.',
      'Prioridade: ALTA.',
    ].join('\n'),
    PRIORITY: 1,                    // 1 = Alta
    DIRECTION: 2,                   // 2 = Saída (nós ligamos para o cliente)
    COMPLETED: 'N',
    COMMUNICATIONS: phone ? [{ VALUE: phone, TYPE: 'PHONE' }] : [],
  };

  if (contactId) fields.OWNER_CONTACT_ID = contactId;
  if (dealId) fields.OWNER_DEAL_ID = dealId;

  return bxCall('/crm.activity.add.json', { fields });
}

// ---------------------------------------------------------------------------
// 7. Open Channels — Mensagem interna (somente operadores)
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem privada no chat do Open Channel, visível apenas para
 * operadores (não para o cliente final).
 *
 * Nota: o Bitrix24 não tem método REST direto para "whisper" real. A melhor
 * abordagem é enviar uma mensagem com SYSTEM=Y via im.message.add — ela é
 * exibida no chat interno com destaque visual (cinza/itálico) mas aparece
 * no stream da conversa. Para whisper real, usar imopenlines.session.message.add
 * (disponível em versões mais recentes).
 *
 * @param {object} params
 * @param {number|string} params.dialogId - ID do diálogo/canal aberto
 * @param {string} params.message - Conteúdo em **BBCode** (não HTML!)
 * @returns {Promise<object>}
 */
export async function sendWhisperMessage({ dialogId, message } = {}) {
  return bxCall('/im.message.add.json', {
    DIALOG_ID: dialogId,
    MESSAGE: message,
    SYSTEM: 'Y',
  });
}

// ---------------------------------------------------------------------------
// 8. Open Channels — Notificação interna para operador
// ---------------------------------------------------------------------------

/**
 * Dispara uma notificação no chat interno do Bitrix24 (IM) alertando a
 * operadora Alice. Usa BBCode (não HTML) — Bitrix24 IM não suporta HTML.
 *
 * @param {object} params
 * @param {number} params.operatorId
 * @param {string} params.clientName
 * @param {string} [params.clientCpf]
 * @param {string} [params.summary]
 * @returns {Promise<object>}
 */
export async function notifyOperator({ operatorId, clientName, clientCpf, summary } = {}) {
  // BBCode — formato suportado pelo Bitrix24 IM
  const lines = [
    '🔔 [B]Atenção Alice: novo cliente transferido do Telegram para o Canal Aberto.[/B]',
    '',
    `👤 [B]Cliente:[/B] ${clientName || 'Não identificado'}`,
    clientCpf ? `🆔 [B]CPF:[/B] ${clientCpf}` : '',
    '',
    summary ? `📋 [B]Resumo da conversa com Hermes:[/B]\n${summary}` : '',
    '',
    '⏰ Verifique o histórico completo no Canal Aberto.',
  ].filter(Boolean);

  return bxCall('/im.notify.json', {
    to: operatorId,
    message: lines.join('\n'),
    type: 'SYSTEM',
  });
}

// ---------------------------------------------------------------------------
// 9. Open Channels — Transferir sessão para operador específico
// ---------------------------------------------------------------------------

/**
 * Atribui a sessão atual de um Canal Aberto a um operador específico.
 *
 * Bitrix24 NÃO tem método "imopenlines.operator.transfer" — o método correto
 * é "imopenlines.session.transfer" (requer SESSION_ID, não CHAT_ID).
 *
 * Como o SESSION_ID precisa ser obtido do evento ONIMOPENLINESSESSIONSTART,
 * esta função tenta (1) transferir via session.transfer se sessionId for
 * fornecido, ou (2) apenas notifica o operador e deixa o atendimento manual.
 *
 * @param {object} params
 * @param {number|string} [params.chatId] - ID do chat (legado, info only)
 * @param {number} [params.sessionId] - ID da sessão do Open Channel
 * @param {number} params.operatorId - ID do operador destino
 * @returns {Promise<object>} Resultado da transferência (ou { skipped: true })
 */
export async function assignChatToOperator({ chatId, sessionId, operatorId } = {}) {
  if (sessionId) {
    return bxCall('/imopenlines.session.transfer.json', {
      SESSION_ID: sessionId,
      TRANSFER_ID: operatorId,
    });
  }
  // Sem sessionId — não há API REST pública para transferir apenas com CHAT_ID.
  // O operador receberá a notificação via notifyOperator() e atenderá manualmente.
  logger.warn(
    `[Bitrix24] assignChatToOperator chamado sem sessionId (chatId=${chatId}). ` +
      `Transferência automática indisponível — operador deve assumir manualmente.`
  );
  return { skipped: true, reason: 'missing_session_id' };
}

// ---------------------------------------------------------------------------
// 10. CRM — Buscar horários de agendamento (Resource Booking)
// ---------------------------------------------------------------------------

/**
 * Retorna os slots disponíveis para agendamento via Resource Booking do CRM.
 * Depende do módulo Resource Booking estar configurado no Bitrix24.
 * @param {object} [params]
 * @param {string} [params.from]
 * @param {string} [params.to]
 * @returns {Promise<Array<object>>}
 */
export async function getAvailableSlots({ from, to } = {}) {
  const resourceId = 1; // TODO: parametrizar conforme CRM
  const result = await bxCall('/resourcebooking.resource.list.json', {
    filter: { ID: resourceId },
  });
  return Array.isArray(result) ? result : [];
}

/**
 * Retorna o link público do Booking do CRM para autoagendamento.
 * @returns {string}
 */
export function getBookingLink() {
  return config.bitrix24.bookingUrl;
}

// ---------------------------------------------------------------------------
// Helper: teste de conectividade com o Bitrix24
// ---------------------------------------------------------------------------

/**
 * Verifica se a API do Bitrix24 está acessível.
 * @returns {Promise<boolean>}
 */
export async function pingBitrix24() {
  try {
    const result = await bxCall('/app.info.json', {});
    return !!result;
  } catch (err) {
    logger.debug(`[Bitrix24] ping falhou: ${err.message}`);
    return false;
  }
}
