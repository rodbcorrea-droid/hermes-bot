// =============================================================================
// services/bitrix24.js
// Integração com a API REST do Bitrix24: CRM, Open Channels, Mensagens.
// Todos os métodos utilizam o padrão de Webhook REST do Bitrix24:
//   POST https://{domain}/rest/{user_id}/{webhook_token}/{method}
// =============================================================================

import axios from 'axios';
import config from '../config/index.js';

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
      `[Bitrix24] Erro em ${operation}: ${error.error_name} — ${error.error_description}`
    );
    err.bxError = error;
    throw err;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. CRM — Busca de Contatos
// ---------------------------------------------------------------------------

/**
 * Busca contatos no CRM por CPF e/ou telefone.
 * O CPF é buscado em um campo personalizado (UF_CRM_*).
 * É necessário mapear o campo customizado de CPF no Bitrix24.
 *
 * @param {object} filters
 * @param {string} [filters.cpf] - CPF do cliente (apenas dígitos)
 * @param {string} [filters.phone] - Telefone do cliente
 * @returns {Promise<Array<object>>} Lista de contatos encontrados
 */
export async function findContactByCpfOrPhone({ cpf, phone } = {}) {
  const filter = { LOGIC: 'OR', '=0': {}, '=1': {} };
  let idx = 0;

  if (cpf) {
    // Campo customizado de CPF — ajuste conforme o ID real do campo no seu CRM
    filter[`=${idx}`] = { 'UF_CRM_CPF': cpf };
    idx++;
  }

  if (phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    filter[`=${idx}`] = {
      'PHONE': cleanPhone.length > 8 ? cleanPhone.slice(-9) : cleanPhone,
    };
    idx++;
  }

  const { data } = await bxClient.post('/crm.contact.list.json', {
    filter,
    select: ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'UF_CRM_CPF', 'EMAIL', 'STAGE_ID'],
  });

  const result = unwrapResult(data, 'crm.contact.list');
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
  const filter = { LOGIC: 'OR', '=0': {}, '=1': {} };
  let idx = 0;

  if (cpf) {
    filter[`=${idx}`] = { 'UF_CRM_CPF': cpf };
    idx++;
  }

  if (phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    filter[`=${idx}`] = {
      'PHONE': cleanPhone.length > 8 ? cleanPhone.slice(-9) : cleanPhone,
    };
    idx++;
  }

  const { data } = await bxClient.post('/crm.lead.list.json', {
    filter,
    select: ['ID', 'NAME', 'LAST_NAME', 'PHONE', 'UF_CRM_CPF', 'STATUS_ID'],
  });

  const result = unwrapResult(data, 'crm.lead.list');
  return Array.isArray(result) ? result : [];
}

// ---------------------------------------------------------------------------
// 3. CRM — Criar novo Lead
// ---------------------------------------------------------------------------

/**
 * Cria um novo Lead no funil inicial da Brandão Correa.
 * @param {object} leadData
 * @param {string} leadData.name - Nome completo do lead
 * @param {string} [leadData.phone] - Telefone
 * @param {string} [leadData.cpf] - CPF
 * @returns {Promise<object>} Lead criado (contém ID)
 */
export async function createLead({ name, phone, cpf } = {}) {
  const fields = {
    TITLE: name || 'Lead via Telegram',
    NAME: name || 'Cliente Telegram',
    SOURCE_ID: 'TELEGRAM',          // Fonte: Telegram
    SOURCE_DESCRIPTION: 'Captado via Bot Hermes (Telegram)',
    OPENED: 'Y',
  };

  if (phone) fields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'MOBILE' }];
  if (cpf) fields.UF_CRM_CPF = cpf;

  const { data } = await bxClient.post('/crm.lead.add.json', { fields });
  return unwrapResult(data, 'crm.lead.add');
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
  if (cpf) contactFields.UF_CRM_CPF = cpf;

  const { data: contactDataResp } = await bxClient.post('/crm.contact.add.json', {
    fields: contactFields,
  });
  const contactId = unwrapResult(contactDataResp, 'crm.contact.add');

  // 4b. Criar Negócio vinculado ao Contato
  const dealFields = {
    TITLE: `Atendimento Telegram — ${name || 'Novo Cliente'}`,
    CONTACT_ID: contactId,
    CATEGORY_ID: 0,            // Funil padrão — ajuste conforme o funil do escritório
    STAGE_ID: 'NEW',           // Estágio inicial
    SOURCE_ID: 'TELEGRAM',
    SOURCE_DESCRIPTION: 'Oportunidade iniciada via Bot Hermes (Telegram)',
    OPENED: 'Y',
  };

  const { data: dealData } = await bxClient.post('/crm.deal.add.json', {
    fields: dealFields,
  });
  const dealId = unwrapResult(dealData, 'crm.deal.add');

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
  const { data } = await bxClient.post('/crm.deal.list.json', {
    filter: { CONTACT_ID: contactId },
    select: ['ID', 'TITLE', 'STAGE_ID', 'DATE_CREATE', 'DATE_MODIFY', 'OPPORTUNITY'],
  });
  return unwrapResult(data, 'crm.deal.list') || [];
}

// ---------------------------------------------------------------------------
// 6. CRM — Registrar Atividade "Chamada Solicitada"
// ---------------------------------------------------------------------------

/**
 * Cria uma atividade do tipo "Chamada" com prioridade alta no CRM,
 * associada ao contato/negócio do cliente.
 *
 * @param {object} params
 * @param {number} params.ownerId - ID do responsável (ex: Alice)
 * @param {number} [params.contactId] - ID do contato
 * @param {number} [params.dealId] - ID do negócio
 * @param {string} [params.phone] - Telefone para callback
 * @returns {Promise<object>}
 */
export async function createCallActivity({ ownerId, contactId, dealId, phone } = {}) {
  const fields = {
    OWNER_ID: ownerId,
    TYPE_ID: 2,                     // 2 = Chamada (Call)
    SUBJECT: 'Solicitação de Chamada — Cliente Telegram',
    DESCRIPTION: `
      Cliente solicitou receber uma ligação via Bot Hermes (Telegram).
      ${phone ? `Telefone informado: ${phone}` : 'Telefone: verificar cadastro do contato.'}
      Prioridade: ALTA.
    `.trim().replace(/\n\s+/g, '\n'),
    PRIORITY: 1,                    // 1 = Alta
    DIRECTION: 2,                   // 2 = Saída (nós ligamos para o cliente)
    COMPLETED: 'N',
    COMMUNICATIONS: phone ? [{ VALUE: phone, TYPE: 'PHONE' }] : [],
  };

  if (contactId) fields.OWNER_CONTACT_ID = contactId;
  if (dealId) fields.OWNER_DEAL_ID = dealId;

  const { data } = await bxClient.post('/crm.activity.add.json', { fields });
  return unwrapResult(data, 'crm.activity.add');
}

// ---------------------------------------------------------------------------
// 7. Open Channels — Mensagem Oculta/Whisper (resumo para operador)
// ---------------------------------------------------------------------------

/**
 * Envia uma mensagem PRIVADA (whisper) no chat do Open Channel do Bitrix24.
 * Esta mensagem NÃO aparece para o cliente final, apenas para os operadores.
 *
 * No Bitrix24, o parâmetro SYSTEM=Y envia mensagem de sistema visível apenas
 * internamente. Utilizamos o método im.message.add com DIALOG_ID do chat.
 *
 * @param {object} params
 * @param {number|string} params.dialogId - ID do diálogo/canal aberto
 * @param {string} params.message - Conteúdo do resumo (HTML simples)
 * @returns {Promise<object>}
 */
export async function sendWhisperMessage({ dialogId, message } = {}) {
  const { data } = await bxClient.post('/im.message.add.json', {
    DIALOG_ID: dialogId,
    MESSAGE: message,
    SYSTEM: 'Y',              // Mensagem do sistema — visível apenas para operadores
    PARAMS: {
      MENU: {},               // Sem menu, apenas texto informativo
    },
  });
  return unwrapResult(data, 'im.message.add (whisper)');
}

// ---------------------------------------------------------------------------
// 8. Open Channels — Notificação interna para operador Alice
// ---------------------------------------------------------------------------

/**
 * Dispara uma notificação no chat interno do Bitrix24 (IM) alertando a
 * operadora Alice sobre um novo atendimento transferido.
 *
 * @param {object} params
 * @param {number} params.operatorId - ID do usuário Alice no Bitrix24
 * @param {string} params.clientName - Nome do cliente
 * @param {string} [params.clientCpf] - CPF do cliente
 * @param {string} [params.summary] - Breve resumo da conversa
 * @returns {Promise<object>}
 */
export async function notifyOperator({ operatorId, clientName, clientCpf, summary } = {}) {
  const message = [
    `🔔 <b>Atenção Alice: novo cliente transferido do Telegram para o Canal Aberto.</b>`,
    ``,
    `👤 <b>Cliente:</b> ${clientName || 'Não identificado'}`,
    clientCpf ? `🆔 <b>CPF:</b> ${clientCpf}` : '',
    ``,
    summary ? `📋 <b>Resumo da conversa com Hermes:</b>\n${summary}` : '',
    ``,
    `⏰ Verifique o histórico completo no Canal Aberto.`,
  ]
    .filter(Boolean)
    .join('\n');

  const { data } = await bxClient.post('/im.notify.json', {
    to: operatorId,
    message,
    type: 'SYSTEM',
  });
  return unwrapResult(data, 'im.notify');
}

// ---------------------------------------------------------------------------
// 9. Open Channels — Transferir chat para operador específico
// ---------------------------------------------------------------------------

/**
 * Atribui o chat de um Canal Aberto a um operador específico (Alice).
 * Utiliza o método imopenlines.operator.answer para o operador "atender"
 * a sessão, ou imopenlines.session.transfer para transferir.
 *
 * Nota: A API exata depende da versão do módulo Open Channels no Bitrix24.
 * Abaixo está a abordagem mais comum via REST.
 *
 * @param {object} params
 * @param {number|string} params.chatId - ID do chat no Open Channel
 * @param {number} params.operatorId - ID do operador Alice
 * @returns {Promise<object>}
 */
export async function assignChatToOperator({ chatId, operatorId } = {}) {
  // Tenta transferir a sessão do Open Channel para o operador Alice
  const { data } = await bxClient.post('/imopenlines.operator.transfer.json', {
    CHAT_ID: chatId,
    TRANSFER_ID: operatorId,
  });
  return unwrapResult(data, 'imopenlines.operator.transfer');
}

// ---------------------------------------------------------------------------
// 10. CRM — Buscar horários de agendamento (Resource Booking)
// ---------------------------------------------------------------------------

/**
 * Retorna os slots disponíveis para agendamento via Resource Booking do CRM.
 * Depende do módulo Resource Booking estar configurado no Bitrix24.
 *
 * @param {object} [params]
 * @param {string} [params.from] - Data inicial (YYYY-MM-DD)
 * @param {string} [params.to] - Data final (YYYY-MM-DD)
 * @returns {Promise<Array<object>>} Slots disponíveis
 */
export async function getAvailableSlots({ from, to } = {}) {
  // O endpoint exato depende da configuração do Resource Booking.
  // Abaixo usamos o padrão de listagem de recursos e slots.
  const resourceId = 1; // ID do recurso (ex: "Advogado") — parametrizar conforme CRM

  const { data } = await bxClient.post('/resourcebooking.resource.list.json', {
    filter: { ID: resourceId },
  });

  const resources = unwrapResult(data, 'resourcebooking.resource.list');
  return resources || [];
}

/**
 * Retorna o link inteligente do Booking do CRM para autoagendamento.
 * @returns {string} URL do Booking público
 */
export function getBookingLink() {
  return `https://${config.bitrix24.domain}/pub/booking/`;
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
    const { data } = await bxClient.post('/app.info.json', {});
    return !!data.result;
  } catch {
    return false;
  }
}
