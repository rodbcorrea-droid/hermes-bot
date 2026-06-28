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
// Helper: gerar variantes de CPF (com e sem pontuação)
function cpfVariants(cpf) {
  const digits = String(cpf || '').replace(/\D/g, '');
  if (digits.length !== 11) return [cpf];
  const formatted = `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6,9)}-${digits.slice(9)}`;
  return [...new Set([cpf, formatted, digits])];
}

export async function findContactByCpfOrPhone({ cpf, phone } = {}) {
  const filter = {};

  if (cpf) {
    const variants = cpfVariants(cpf);
    if (variants.length === 1) {
      filter[config.bitrix24.cpfCustomField] = variants[0];
    } else {
      filter[`%${config.bitrix24.cpfCustomField}`] = variants;
    }
  }

  if (phone) {
    const variants = phoneVariants(phone);
    if (variants.length === 1) {
      filter.PHONE = variants[0];
    } else {
      filter['%PHONE'] = variants;
    }
  }

  if (Object.keys(filter).length === 0) return [];

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
  const filter = {};

  if (cpf) {
    const variants = cpfVariants(cpf);
    if (variants.length === 1) {
      filter[config.bitrix24.cpfCustomField] = variants[0];
    } else {
      filter[`%${config.bitrix24.cpfCustomField}`] = variants;
    }
  }

  if (phone) {
    const variants = phoneVariants(phone);
    if (variants.length === 1) {
      filter.PHONE = variants[0];
    } else {
      filter['%PHONE'] = variants;
    }
  }

  if (Object.keys(filter).length === 0) return [];

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

// Mapas de enumeração (ID → Nome legível)
const SERVICO_ENUM = Object.freeze({
  '2309': 'ADM Auxilio Doença Facultativo',
  '2311': 'ADM Auxilio Maternidade Facultativo',
  '2313': 'ADM Auxilio Doença',
  '2315': 'ADM Auxilio Maternidade',
  '2317': 'ADM Auxílio Acidente',
  '2319': 'ADM LOAS / BPC',
  '3411': 'ADM Aposentadoria por Idade',
  '4509': 'ADM Auxilio Doença MEI',
  '3413': 'ADM Aposentadoria por Invalidez',
  '5793': 'ADM Aposentadoria Rural',
  '3415': 'ADM Pensão INSS',
  '4523': 'ADM Cobrança de Seguros',
  '6851': 'ADM Cobrança de Valores atrasados',
  '4525': 'Outros',
  '5415': 'JUD Auxílio Acidente',
  '8371': 'JUD Auxilio Doença Facultativo',
  '8373': 'JUD Auxilio Maternidade Facultativo',
  '8375': 'JUD Auxilio Doença',
  '8377': 'JUD Auxilio Maternidade',
  '8379': 'JUD LOAS / BPC',
  '8381': 'JUD Aposentadoria por Idade',
  '8383': 'JUD Auxilio Doença MEI',
  '8385': 'JUD Aposentadoria por Invalidez',
  '8387': 'JUD Aposentadoria Rural',
  '8389': 'JUD Pensão INSS',
  '8391': 'JUD Cobrança de Seguros',
  '8393': 'JUD Cobrança de Valores atrasados',
});

const FASE_ENUM = Object.freeze({
  '1889': 'PREVI ADM ➡️ Recepção da Pasta',
  '1909': 'PREVI ADM / Processo Administrativo',
  '3727': 'PREVI ADM / Processo Administrativo/ GUIA PG',
  '4153': 'PREVI ADM / Processo Administrativo/ AGUARDA PG DA GUIA',
  '4109': 'PREVI ADM / Pendencia / Aguardando Senha',
  '1891': 'PREVI ADM / Pendencia / Verificação de 2 fatores',
  '1893': 'PREVI ADM / Pendencia / Questionário',
  '1895': 'PREVI ADM / Pendencia / Dados divergentes',
  '1897': 'PREVI ADM / Pendencia / Falta documentos',
  '1899': 'PREVI ADM / Pendencia / Benefício em aberto',
  '1915': 'PREVI ADM / Indeferido / Reprotocola Adm',
  '1901': 'PREVI ADM / Pendencia / Sem NIT',
  '1905': 'PREVI ADM / Aguarda Perícia',
  '1903': 'PREVI ADM / Avaliação Social LOAS',
  '4103': 'PREVI ADM / Processo Administrativo / Gela',
  '1907': 'PREVI ADM / Aguardando Laudos - Aux Acidente',
  '1911': 'PREVI ADM / Perícia Administrativa',
  '5419': 'PREVI ADM / Perícia Administrativa ➡️ Falta Perícia',
  '1919': 'PREVI ADM ➡️ Concedido ➡️ em pagamento',
  '1913': 'PREVI ADM ➡️ Concedido Parcial ➡️ Judicial',
  '4967': 'PREVI ADM ➡️ Concedido ➡️ Arquivo',
  '20777': 'PREVI ADM / Indeferido ➡️ Recurso Adm',
  '5405': 'PREVI ADM / Indeferido ➡️ Será reprotocolado',
  '1917': 'PREVI ADM / Indeferido ➡️ Judicial',
  '4969': 'PREVI ADM / Indeferido ➡️ Arquivo',
  '1921': 'PREVI ADM ⚠️ Cliente inadimplente ⚠️',
  '1923': 'PREVI ADM / Fatura final',
  '5431': '✅ PREVI JUDICIAL / Recepção pasta',
  '2011': '✅ PREVI JUDICIAL / Protocolado',
  '1977': '✅ PREVI JUDICIAL / Perícia Médica',
  '1979': '✅ PREVI JUDICIAL / Em andamento',
  '1981': '✅ PREVI JUDICIAL / Sentença ➡️ Ação Procedente',
  '1989': '✅ PREVI JUDICIAL ➡️ Aguarda pagamento mensal',
  '1983': '✅ PREVI JUDICIAL / Execução',
  '1985': '✅ PREVI JUDICIAL / Honorários',
  '1987': '✅ PREVI JUDICIAL / Fatura final',
  '4979': '✅ PREVI JUDICIAL / Improcedência ➡️ Arquivo',
  '1991': '✅ PREVI JUDICIAL / Improcedência ➡️ Tenta Adm',
  '1993': '✅ PREVI JUDICIAL / Extinta sem resolução / reprotocola',
  '1995': 'EXECUÇÃO ROD / Protocolo',
  '1997': 'EXECUÇÃO ROD / Em andamento',
  '1999': 'EXECUÇÃO ROD / Sentença',
  '2003': 'EXECUÇÃO ROD / Fatura final',
  '2005': 'EXECUÇÃO ROD / Execução efetiva',
  '2007': 'EXECUÇÃO ROD / Execução sem efetividade',
  '2009': 'EXECUÇÃO ROD / Extinção sem Resolução / reprotocola',
  '2001': 'EXECUÇÃO ROD / Suspensão - Protesto Cartório',
  '4537': '✅ SEGUROS ADM ➡️ Protocolo',
  '4539': '✅ SEGUROS ADM ➡️ Perícia',
  '4541': '✅ SEGUROS ADM ➡️ Concedido ➡️ Judicial diferença',
  '4543': '✅ SEGUROS ADM ➡️ Concedido ➡️ Arquivo',
  '4981': '✅ SEGUROS ADM ➡️ Negado ➡️ Judicial',
  '4983': '✅ SEGUROS ADM ➡️ Negado ➡️ Arquivo',
  '4513': '✅ SEGUROS JUD ➡️ Protocolo',
  '4527': '✅ SEGUROS JUD ➡️ Perícia',
  '4529': '✅ SEGUROS JUD ➡️ Sentença ➡️ Procedência',
  '4991': '✅ SEGUROS JUD ➡️ Procedência ➡️ Recurso',
  '4531': '✅ SEGUROS JUD ➡️ Execução',
  '4533': '✅ SEGUROS JUD ➡️ Improcedência ➡️ Reprotocola',
  '4989': '✅ SEGUROS JUD ➡️ Improcedência ➡️ Recurso',
  '4535': '✅ SEGUROS JUD ➡️ Improcedência ➡️ Arquivo',
  '6015': 'Execução ➡️ Acordo ➡️ Em pagamento',
  '5519': 'PREVI ADM ➡️ Concedido ➡️ encaminhado para Financeiro',
  '5783': '➡️ PASTA CANCELADA ✅',
  '8783': '✍️ Acordo Extrajudicial ➡️ Em pagamento',
});

/**
 * Resolve ID de enumeração para nome legível.
 * Se já for texto (não é número), retorna como está.
 * @param {string|number} value - ID ou texto
 * @param {object} enumMap - Mapa de enumeração
 * @returns {string}
 */
function resolveEnum(value, enumMap) {
  if (!value) return '';
  const str = String(value).trim();
  // Se já é texto legível (não é só número), retorna como está
  if (!/^\d+$/.test(str)) return str;
  return enumMap[str] || str;
}

/**
 * Busca os negócios (processos) vinculados a um contato.
 * @param {number} contactId
 * @returns {Promise<Array<object>>}
 */
export async function getDealsByContact(contactId) {
  const result = await bxCall('/crm.deal.list.json', {
    filter: { CONTACT_ID: contactId },
    select: [
      'ID', 'TITLE', 'STAGE_ID', 'STAGE_SEMANTIC_ID', 'CATEGORY_ID',
      'DATE_CREATE', 'DATE_MODIFY', 'OPPORTUNITY', 'CURRENCY_ID',
      'BEGINDATE', 'CLOSEDATE',
      'UF_CRM_1731420853730',  // Serviço contratado
      'UF_CRM_1771620131891',  // Protocolo ADM
      'UF_CRM_672A1CBB2CF15',  // Fase processual
      'UF_CRM_1747841518875',  // Conclusão do processo
      'UF_CRM_1747506217',     // Número do benefício
      'UF_CRM_1768833736',     // DPP (Data Previsão do Parto)
      'UF_CRM_1781633400621',  // DUM (Data última Menstruação)
      'UF_CRM_1768574725',     // Semanas de Gestação (calculado)
      'UF_CRM_1747841285241',  // Data de protocolo (certidão)
      'UF_CRM_1774123742374',  // Status do protocolo
      'UF_CRM_1747855086',     // Data/Hora da Perícia
      'UF_CRM_1747840589237',  // Local da Perícia
    ],
  });
  return Array.isArray(result) ? result : [];
}

/**
 * Busca um deal específico com todos os campos customizados.
 * @param {number} dealId
 * @returns {Promise<object>}
 */
export async function getDealDetails(dealId) {
  const result = await bxCall('/crm.deal.get.json', { id: dealId });
  return result;
}

/**
 * Determina o status legível do estágio do deal.
 * @param {object} deal
 * @returns {{ emoji: string, label: string, isConcedido: boolean }}
 */
export function getStageStatus(deal) {
  const stageId = (deal.STAGE_ID || '').toUpperCase();
  const semanticId = deal.STAGE_SEMANTIC_ID || '';

  // Verificar por semantic ID primeiro (mais confiável)
  if (semanticId === 'S' || stageId.includes(':WON') || stageId.includes(':SUCCESS')) {
    return { emoji: '✅', label: 'Concedido', isConcedido: true };
  }
  if (semanticId === 'F' || stageId.includes(':LOSE') || stageId.includes(':FAIL')) {
    return { emoji: '❌', label: 'Indeferido / Cancelado', isConcedido: false };
  }
  // Padrão: em andamento
  return { emoji: '⏳', label: 'Em andamento', isConcedido: false };
}

/**
 * Formata um deal para exibição resumida (lista de seleção).
 * @param {object} deal
 * @param {number} index
 * @returns {string}
 */
export function formatDealSummary(deal, index) {
  const { emoji, label } = getStageStatus(deal);
  const servico = resolveEnum(deal.UF_CRM_1731420853730, SERVICO_ENUM) || deal.TITLE || 'Sem título';
  const dataInicio = deal.BEGINDATE
    ? new Date(deal.BEGINDATE).toLocaleDateString('pt-BR', { timeZone: 'America/Cuiaba' })
    : 'N/D';

  return (
    `<b>${index + 1}.</b> ${servico}\n` +
    `   ${emoji} ${label}\n` +
    `   📅 Início: ${dataInicio}`
  );
}

/**
 * Formata os detalhes completos de um deal para o cliente.
 * Se o stage for "Concedido", inclui conclusão e número do benefício.
 * @param {object} deal
 * @returns {string}
 */
export function formatDealDetails(deal, clientName) {
  const { emoji, label, isConcedido } = getStageStatus(deal);
  const lines = [];

  // Título / Serviço contratado
  const servico = resolveEnum(deal.UF_CRM_1731420853730, SERVICO_ENUM) || deal.TITLE || 'Não informado';
  lines.push(`📋 <b>Serviço:</b> ${servico}`);
  lines.push('');

  // Status (Stage)
  lines.push(`${emoji} <b>Status:</b> ${label}`);

  // Protocolo ADM
  const protocolo = deal.UF_CRM_1771620131891;
  if (protocolo) {
    lines.push(`🔖 <b>Protocolo ADM:</b> ${protocolo}`);
  }

  // Fase processual
  const fase = resolveEnum(deal.UF_CRM_672A1CBB2CF15, FASE_ENUM);
  if (fase) {
    lines.push(`⚖️ <b>Fase processual:</b> ${fase}`);
  }

  // Datas
  const dataInicio = deal.BEGINDATE
    ? new Date(deal.BEGINDATE).toLocaleDateString('pt-BR', { timeZone: 'America/Cuiaba' })
    : null;
  if (dataInicio) {
    lines.push(`📅 <b>Data de início:</b> ${dataInicio}`);
  }

  // Campos extras somente quando CONCEDIDO
  if (isConcedido) {
    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('🎉 <b>INFORMAÇÕES DO BENEFÍCIO</b>');
    lines.push('');

    const conclusao = deal.UF_CRM_1747841518875;
    if (conclusao) {
      const dataConclusao = new Date(conclusao).toLocaleDateString('pt-BR', { timeZone: 'America/Cuiaba' });
      lines.push(`📅 <b>Conclusão do processo:</b> ${dataConclusao}`);
    }

    const numBeneficio = deal.UF_CRM_1747506217;
    if (numBeneficio) {
      lines.push(`🔢 <b>Número do benefício:</b> ${numBeneficio}`);
    }
  }

  // Bloco especial para Auxílio Maternidade
  if (isMaternityBenefit(servico)) {
    lines.push(formatMaternityBlock(deal));
  }

  // Bloco especial para benefícios com Perícia Médica
  if (isPericiaBenefit(servico) && deal.UF_CRM_1747855086) {
    lines.push(formatPericiaBlock(deal, clientName));
  }

  return lines.join('\n');
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
  // Registrar como comentário no timeline do contato/deal
  const lines = [
    '📞 [B]Solicitação de Chamada — Cliente Telegram[/B]',
    '',
    phone ? `Telefone informado: ${phone}` : 'Telefone: verificar cadastro do contato.',
    'Prioridade: [B]ALTA[/B]',
    '',
    'O cliente solicitou receber uma ligação via bot Telegram.',
  ];

  // Adicionar no timeline do deal se disponível
  if (dealId) {
    try {
      await bxCall('/crm.timeline.comment.add.json', {
        fields: {
          ENTITY_ID: dealId,
          ENTITY_TYPE: 'DEAL',
          COMMENT: lines.join('\n'),
        },
      });
    } catch (err) {
      logger.warn(`[Bitrix24] Falha ao comentar no deal ${dealId}: ${err.message}`);
    }
  }

  // Adicionar no timeline do contato se disponível
  if (contactId) {
    try {
      await bxCall('/crm.timeline.comment.add.json', {
        fields: {
          ENTITY_ID: contactId,
          ENTITY_TYPE: 'CONTACT',
          COMMENT: lines.join('\n'),
        },
      });
    } catch (err) {
      logger.warn(`[Bitrix24] Falha ao comentar no contato ${contactId}: ${err.message}`);
    }
  }

  return { success: true };
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
// IDs das salas de vídeo disponíveis para agendamento
const VIDEO_ROOM_IDS = [9, 11, 13]; // Chamada de Vídeo / Aux. Maternidade, 1 e 2
const PERICIA_ROOM_ID = 5; // Orientação Perícia Cbá

/**
 * Busca bookings existentes nas salas de vídeo para um período.
 * @param {string} fromDate - Data início (YYYY-MM-DD)
 * @param {string} toDate - Data fim (YYYY-MM-DD)
 * @returns {Promise<Array>}
 */
export async function getExistingBookings(fromDate, toDate) {
  try {
    // Converter datas para timestamps
    const fromTs = Math.floor(new Date(fromDate + 'T00:00:00').getTime() / 1000);
    const toTs = Math.floor(new Date(toDate + 'T23:59:59').getTime() / 1000);
    
    const result = await bxCall('/booking.v1.booking.list.json', {
      filter: {
        resourceIds: VIDEO_ROOM_IDS,
        datePeriod: {
          from: { timestamp: String(fromTs), timezone: 'America/Cuiaba' },
          to: { timestamp: String(toTs), timezone: 'America/Cuiaba' },
        },
      },
    });
    
    return result?.booking || [];
  } catch (err) {
    logger.warn(`[Bitrix24] Erro ao buscar bookings: ${err.message}`);
    return [];
  }
}

/**
 * Gera slots disponíveis (30min) no próximo dia útil entre 8h-18h.
 * Retorna 3 opções de horários diferentes salas.
 * @param {Array} existingBookings - Bookings já existentes
 * @returns {Array<{fromTs: number, toTs: number, label: string, resourceId: number, from: string, to: string}>}
 */
/**
 * Cria um Date em UTC representando um horário local no timezone especificado.
 * Ex: createDateInTZ('America/Cuiaba', 2026, 6, 29, 8, 0) → Date em UTC
 * que quando exibida em Cuiabá mostra 08:00.
 */
function createDateInTZ(timezone, year, month, day, hour, min = 0) {
  // Criar data candidata em UTC
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, min, 0));
  // Descobrir o offset do timezone naquela data
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcGuess);

  const get = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  const tzHour = get('hour') === 24 ? 0 : get('hour');
  const tzMin = get('minute');
  const tzDay = get('day');
  const tzMonth = get('month');

  // Diferença em minutos entre o que queremos e o que o timezone mostra
  // Se queremos dia 29 às 08:00 mas o timezone mostra dia 29 às 12:00 (UTC),
  // então precisamos subtrair 4 horas do UTC
  const targetMinutes = hour * 60 + min;
  const actualMinutes = tzHour * 60 + tzMin;
  let diffMinutes = actualMinutes - targetMinutes;

  // Ajustar se cruzou dia
  if (tzDay !== day) {
    diffMinutes += (tzDay > day ? -1 : 1) * 24 * 60;
  }

  const result = new Date(utcGuess.getTime() - diffMinutes * 60 * 1000);
  return result;
}

/**
 * Gera slots disponíveis (30min) no próximo dia útil entre 8h-18h.
 * Retorna 3 opções de horários diferentes salas.
 * @param {Array} existingBookings - Bookings já existentes
 * @returns {Array<{fromTs: number, toTs: number, label: string, resourceId: number, from: string, to: string}>}
 */
export function generateAvailableSlots(existingBookings = []) {
  const slots = [];
  const now = new Date();
  const timezone = 'America/Cuiaba';

  // Descobrir "hoje" no timezone Cuiabá
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    weekday: 'short',
  }).formatToParts(now);

  const get = (type) => nowParts.find(p => p.type === type).value;
  const todayCuiaba = new Date(`${get('year')}-${get('month').padStart(2, '0')}-${get('day').padStart(2, '0')}T12:00:00`);
  const startDate = new Date(todayCuiaba);
  startDate.setDate(startDate.getDate() + 1);

  // Pular fins de semana
  while (startDate.getDay() === 0 || startDate.getDay() === 6) {
    startDate.setDate(startDate.getDate() + 1);
  }

  const year = startDate.getFullYear();
  const month = startDate.getMonth() + 1;
  const day = startDate.getDate();

  const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const monthNames = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const dayName = dayNames[startDate.getDay()];
  const monthName = monthNames[startDate.getMonth()];
  const dayNum = day;

  // Horários disponíveis: 8:00, 8:30, 9:00, 9:30, 10:00, 10:30, 11:00, 11:30,
  //                       13:00, 13:30, 14:00, 14:30, 15:00, 15:30, 16:00, 16:30, 17:00, 17:30
  const availableHours = [
    [8, 0], [8, 30], [9, 0], [9, 30], [10, 0], [10, 30], [11, 0], [11, 30],
    [13, 0], [13, 30], [14, 0], [14, 30], [15, 0], [15, 30], [16, 0], [16, 30], [17, 0], [17, 30],
  ];

  // Para cada sala de vídeo, encontrar o primeiro horário disponível
  for (const resourceId of VIDEO_ROOM_IDS) {
    if (slots.length >= 3) break;

    for (const [hour, min] of availableHours) {
      if (slots.length >= 3) break;

      const slotStart = createDateInTZ(timezone, year, month, day, hour, min);
      const slotEnd = createDateInTZ(timezone, year, month, day, hour, min + 30);

      const fromTs = Math.floor(slotStart.getTime() / 1000);
      const toTs = Math.floor(slotEnd.getTime() / 1000);

      // Verificar se conflita com booking existente nesta sala
      const hasConflict = existingBookings.some(booking => {
        if (!booking.resourceIds?.includes(resourceId)) return false;
        const bookingFrom = parseInt(booking.datePeriod?.from?.timestamp || 0);
        const bookingTo = parseInt(booking.datePeriod?.to?.timestamp || 0);
        return fromTs < bookingTo && toTs > bookingFrom;
      });

      if (!hasConflict) {
        const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        const roomNames = { 9: 'Chamada de Vídeo', 11: 'Chamada de Vídeo 1', 13: 'Chamada de Vídeo 2' };

        slots.push({
          fromTs,
          toTs,
          from: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${timeStr}:00`,
          to: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min + 30).padStart(2, '0')}:00`,
          label: `${dayName}, ${dayNum} de ${monthName} às ${timeStr} — ${roomNames[resourceId]}`,
          resourceId,
          roomName: roomNames[resourceId],
        });
      }
    }
  }

  return slots;
}

/**
 * Cria um booking na sala de vídeo selecionada.
 * @param {object} params
 * @param {string} params.name - Nome do cliente
 * @param {number} params.resourceId - ID do recurso (sala)
 * @param {number} params.fromTs - Timestamp início
 * @param {number} params.toTs - Timestamp fim
 * @param {string} [params.description] - Descrição
 * @returns {Promise<number>} ID do booking criado
 */
export async function createBooking({ name, resourceId, fromTs, toTs, description, contactId, dealId }) {
  console.log(`[BOOKING] Criando booking: sala=${resourceId}, from=${fromTs}, to=${toTs}, nome=${name}, contato=${contactId}, deal=${dealId}`);
  const fields = {
    resourceIds: [resourceId],
    name: name || 'Agendamento via Bot',
    description: description || '',
    datePeriod: {
      from: { timestamp: String(fromTs), timezone: 'America/Cuiaba' },
      to: { timestamp: String(toTs), timezone: 'America/Cuiaba' },
    },
  };

  // Vincular ao contato e deal para que o sistema de booking envie confirmações
  if (contactId) fields.contactId = contactId;
  if (dealId) fields.dealId = dealId;

  const result = await bxCall('/booking.v1.booking.add.json', { fields });
  console.log(`[BOOKING] ✅ Booking criado: ID=${result}`);

  // Vincular booking ao deal/contato via CRM Activity
  // A API booking.v1 não vincula entidades CRM diretamente,
  // então criamos um CRM Activity com BINDINGS que ligam o booking ao deal E contato
  if (result && (dealId || contactId)) {
    try {
      // Montar bindings para deal e contato
      const bindings = [];
      if (dealId) bindings.push({ ENTITY_TYPE: 'deal', ENTITY_ID: dealId });
      if (contactId) bindings.push({ ENTITY_TYPE: 'contact', ENTITY_ID: contactId });

      const activityFields = {
        SUBJECT: `📅 Agendamento: ${name}`,
        DESCRIPTION: description || `Booking #${result} criado via bot Telegram`,
        TYPE_ID: 6, // Tipo: Reunião/Chamada
        COMPLETED: 'N',
        RESPONSIBLE_ID: config.bitrix24.userId,
        START_TIME: new Date(fromTs * 1000).toISOString().slice(0, 19).replace('T', ' '),
        END_TIME: new Date(toTs * 1000).toISOString().slice(0, 19).replace('T', ' '),
        // OWNER = deal (primário) ou contato
        OWNER_TYPE_ID: dealId ? 2 : 3, // 2=Deal, 3=Contact
        OWNER_ID: dealId || contactId,
        // Provider obrigatório para crm.activity.add funcionar
        PROVIDER_ID: 'CRM_BOOKING',
        PROVIDER_TYPE_ID: 'BOOKING',
        // BINDINGS vincula a activity ao deal E contato simultaneamente
        BINDINGS: bindings,
      };

      const activityResult = await bxCall('/crm.activity.add.json', { fields: activityFields });
      console.log(`[BOOKING] ✅ CRM Activity criado: ID=${activityResult} | bindings: ${bindings.map(b => `${b.ENTITY_TYPE}#${b.ENTITY_ID}`).join(', ')}`);
    } catch (activityErr) {
      // Se crm.activity.add falhar, usar timeline comment como fallback
      console.log(`[BOOKING] ⚠️ crm.activity.add falhou: ${activityErr.message} — usando timeline comment`);

      if (dealId) {
        try {
          await bxCall('/crm.timeline.comment.add.json', {
            fields: {
              ENTITY_ID: dealId,
              ENTITY_TYPE: 'deal',
              COMMENT: `📅 <b>Agendamento criado via Bot Telegram</b><br>` +
                `Booking: #${result}<br>` +
                `Cliente: ${name}<br>` +
                `Horário: ${new Date(fromTs * 1000).toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' })}<br>` +
                `Sala: ${description?.match(/Sala: (.+)/)?.[1] || 'N/A'}`,
            },
          });
          console.log(`[BOOKING] ✅ Timeline comment adicionado ao Deal #${dealId}`);
        } catch (timelineErr) {
          console.log(`[BOOKING] ⚠️ Timeline comment falhou: ${timelineErr.message}`);
        }
      }

      if (contactId) {
        try {
          await bxCall('/crm.timeline.comment.add.json', {
            fields: {
              ENTITY_ID: contactId,
              ENTITY_TYPE: 'contact',
              COMMENT: `📅 <b>Agendamento criado via Bot Telegram</b><br>` +
                `Booking: #${result}<br>` +
                `Horário: ${new Date(fromTs * 1000).toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' })}`,
            },
          });
          console.log(`[BOOKING] ✅ Timeline comment adicionado ao Contact #${contactId}`);
        } catch (timelineErr) {
          console.log(`[BOOKING] ⚠️ Timeline comment (contact) falhou: ${timelineErr.message}`);
        }
      }
    }
  }

  return result;
}

/**
 * Cria um novo Deal (negócio) no CRM.
 * @param {object} params
 * @param {string} params.title - Título
 * @param {number} [params.contactId] - ID do contato
 * @param {number} [params.assignedById] - ID do responsável
 * @param {number} [params.categoryId] - ID da categoria do funil
 * @returns {Promise<number>} ID do deal criado
 */
export async function createDeal({ title, contactId, assignedById, categoryId }) {
  const fields = {
    TITLE: title,
    ASSIGNED_BY_ID: assignedById || config.bitrix24.userId,
  };
  if (contactId) fields.CONTACT_ID = contactId;
  if (categoryId !== undefined) fields.CATEGORY_ID = categoryId;
  
  const result = await bxCall('/crm.deal.add.json', { fields });
  return result;
}

/**
 * Retorna o link público do Booking do CRM para autoagendamento.
 * @returns {string}
 */
export function getBookingLink() {
  return config.bitrix24.bookingUrl;
}

// ---------------------------------------------------------------------------
// 11. SPA 1130 (Fatura Nova) — 2ª via de boleto
// ---------------------------------------------------------------------------

/**
 * Busca faturas (SPA 1130) vinculadas a um contato.
 * @param {number} contactId - ID do contato no CRM
 * @returns {Promise<Array<object>>} Lista de faturas
 */
export async function getFaturasByContact(contactId) {
  try {
    const result = await bxCall('/crm.item.list.json', {
      entityTypeId: 1130,
      filter: { contactId },
      select: [
        'id', 'title', 'stageId', 'opportunity', 'currencyId',
        'contactId', 'assignedById',
        'ufCrm45_1757081693',  // Link do boleto (Asaas)
        'ufCrm45_1780064669',  // Comprovante de pagamento
        'ufCrm45_1757081738',  // Nota fiscal
        'ufCrm45_1757341257',  // Data de vencimento
        'ufCrm45_1758724694',  // Descrição/serviço
        'ufCrm45_1757341045',  // Total de parcelas
        'ufCrm45_1757341060',  // Parcela atual
        'ufCrm45_1757686357',  // Valor a receber (parcela atual)
      ],
    });
    return Array.isArray(result?.items) ? result.items : (Array.isArray(result) ? result : []);
  } catch (err) {
    logger.warn(`[Bitrix24] Erro ao buscar faturas (SPA 1130): ${err.message}`);
    return [];
  }
}

/**
 * Formata uma fatura para exibição ao cliente no Telegram.
 * @param {object} fatura - Item da SPA 1130
 * @returns {string} Texto formatado em HTML
 */
export function formatFatura(fatura) {
  const lines = [];

  // Título/serviço
  const servico = fatura.ufCrm45_1758724694 || fatura.title || 'Serviço';
  lines.push(`📄 <b>${servico}</b>`);

  // Parcelas (X de Y)
  const parcelaAtual = fatura.ufCrm45_1757341060;
  const totalParcelas = fatura.ufCrm45_1757341045;
  if (parcelaAtual && totalParcelas) {
    lines.push(`📊 Parcela: <b>${parcelaAtual} de ${totalParcelas}</b>`);
  }

  // Valor da parcela atual (valor a receber)
  const valorReceber = fatura.ufCrm45_1757686357;
  if (valorReceber) {
    const valorStr = parseCurrencyValue(valorReceber, fatura.currencyId || 'BRL');
    lines.push(`💰 Valor da parcela: <b>${valorStr}</b>`);
  } else if (fatura.opportunity) {
    const valorStr = parseFloat(fatura.opportunity).toLocaleString('pt-BR', {
      style: 'currency',
      currency: fatura.currencyId || 'BRL',
    });
    lines.push(`💰 Valor: <b>${valorStr}</b>`);
  }

  // Vencimento
  const vencimento = fatura.ufCrm45_1757341257;
  if (vencimento) {
    const dataVenc = formatDateBR(vencimento);
    const hoje = new Date();
    const dataVencObj = new Date(vencimento);
    let vencLabel = '';
    if (dataVencObj < hoje && !fatura.stageId?.includes('SUCCESS')) {
      vencLabel = ' ⚠️ <b>VENCIDO</b>';
    }
    lines.push(`📅 Vencimento: <b>${dataVenc}</b>${vencLabel}`);
  }

  // Status
  const stageId = fatura.stageId || '';
  let statusEmoji = '⏳';
  let statusText = 'Pendente';
  if (stageId.includes('SUCCESS')) {
    statusEmoji = '✅';
    statusText = 'Pago';
  } else if (stageId.includes('PREPARATION')) {
    statusEmoji = '📋';
    statusText = 'Em preparação';
  } else if (stageId.includes('FAIL') || stageId.includes('LOSE')) {
    statusEmoji = '❌';
    statusText = 'Cancelado';
  }
  lines.push(`${statusEmoji} Status: <b>${statusText}</b>`);
  lines.push('');

  // Link do boleto
  const boletoLink = fatura.ufCrm45_1757081693;
  if (boletoLink) {
    lines.push(`🔗 <b>Link do Boleto:</b>`);
    lines.push(`<a href="${boletoLink}">📄 Acessar Boleto</a>`);
    lines.push('');
  }

  // Comprovante de pagamento
  const comprovante = fatura.ufCrm45_1780064669;
  if (comprovante) {
    lines.push(`🧾 <b>Comprovante de Pagamento:</b>`);
    lines.push(`<a href="${comprovante}">📄 Ver Comprovante</a>`);
    lines.push('');
  }

  // Nota fiscal
  const notaFiscal = fatura.ufCrm45_1757081738;
  if (notaFiscal) {
    lines.push(`📋 <b>Nota Fiscal:</b>`);
    lines.push(`<a href="${notaFiscal}">📄 Ver Nota Fiscal</a>`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Helper: formata valor monetário do Bitrix24.
 * O campo pode vir como "30|BRL", "100|BRL" ou apenas número.
 */
function parseCurrencyValue(value, currency) {
  if (!value) return 'N/D';
  const strValue = String(value);
  // Formato "100|BRL"
  if (strValue.includes('|')) {
    const [amount] = strValue.split('|');
    return parseFloat(amount).toLocaleString('pt-BR', {
      style: 'currency',
      currency: currency,
    });
  }
  return parseFloat(strValue).toLocaleString('pt-BR', {
    style: 'currency',
    currency: currency,
  });
}

/**
 * Helper: formata data ISO para DD/MM/YYYY.
 */
function formatDateBR(dateStr) {
  if (!dateStr) return 'N/D';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('pt-BR', { timeZone: 'America/Cuiaba' });
  } catch {
    return dateStr;
  }
}

/**
 * Helper: verifica se o serviço é de auxílio maternidade.
 */
function isMaternityBenefit(servico) {
  if (!servico) return false;
  const s = servico.toLowerCase();
  return s.includes('auxilio maternidade') || s.includes('auxílio maternidade');
}

/**
 * Helper: verifica se o serviço requer perícia médica.
 */
function isPericiaBenefit(servico) {
  if (!servico) return false;
  const s = servico.toLowerCase();
  return (
    s.includes('auxílio acidente') || s.includes('auxilio acidente') ||
    s.includes('auxílio doença') || s.includes('auxilio doenca') || s.includes('auxílio doença') ||
    s.includes('loas') || s.includes('bpc')
  );
}

/**
 * Gera o bloco especial de maternidade para exibição ao cliente.
 * Inclui DPP, DUM, semanas de gestação e lógica de certidão de nascimento.
 * @param {object} deal
 * @returns {string} Texto formatado em HTML
 */
export function formatMaternityBlock(deal) {
  const lines = [];
  const servico = resolveEnum(deal.UF_CRM_1731420853730, SERVICO_ENUM) || '';

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('🤰 <b>INFORMAÇÕES DE MATERNIDADE</b>');
  lines.push('');

  // DUM
  const dum = deal.UF_CRM_1781633400621;
  if (dum) {
    lines.push(`🩸 <b>DUM (Data Última Menstruação):</b> ${formatDateBR(dum)}`);
  }

  // DPP
  const dpp = deal.UF_CRM_1768833736;
  if (dpp) {
    lines.push(`📅 <b>DPP (Previsão do Parto):</b> ${formatDateBR(dpp)}`);
  }

  // Semanas de gestação
  const semanas = deal.UF_CRM_1768574725;
  if (semanas) {
    lines.push(`⏱️ <b>Semanas de Gestação:</b> ${semanas}`);
  }

  lines.push('');

  // Verificar se já houve parto (DPP já passou)
  const dppDate = dpp ? new Date(dpp) : null;
  const hoje = new Date();
  const jaHouveParto = dppDate ? dppDate < hoje : false;

  // Verificar se certidão já foi enviada (protocolo existe)
  const dataProtocolo = deal.UF_CRM_1747841285241;
  const statusProtocolo = deal.UF_CRM_1774123742374;
  const certidaoEnviada = !!dataProtocolo;

  if (certidaoEnviada) {
    // Certidão já enviada — mostrar protocolo e status
    lines.push('✅ <b>Certidão de nascimento já protocolada!</b>');
    lines.push('');
    if (dataProtocolo) {
      lines.push(`📅 <b>Data do protocolo:</b> ${formatDateBR(dataProtocolo)}`);
    }
    if (statusProtocolo) {
      lines.push(`📌 <b>Status:</b> ${statusProtocolo}`);
    }
  } else if (jaHouveParto) {
    // Já houve parto mas certidão NÃO enviada — insistir
    lines.push('⚠️ <b>ATENÇÃO: Parto já ocorreu!</b>');
    lines.push('');
    lines.push('Verificamos que a data prevista do parto já passou.');
    lines.push('');
    lines.push('📄 <b>Você já enviou a Certidão de Nascimento do bebê?</b>');
    lines.push('');
    lines.push('❗ <b>É URGENTE enviar a certidão para dar prosseguimento ao processo!</b>');
    lines.push('Sem ela, o INSS não irá analisar o benefício.');
    lines.push('');
    lines.push('📤 Por favor, envie a certidão o mais rápido possível.');
    lines.push('Se tiver dúvidas de como enviar, assista ao tutorial:');
    lines.push(`<a href="https://vimeo.com/1177468232?share=copy&fl=sv&fe=ci">📺 Tutorial: Como enviar a Certidão</a>`);
  } else {
    // Ainda não houve parto — informar sobre andamento
    lines.push('ℹ️ <b>Andamento do Processo</b>');
    lines.push('');
    lines.push('Já estamos trabalhando no seu processo! 💪');
    lines.push('');
    lines.push('De acordo com nossa análise prévia, neste momento');
    lines.push('<b>somente a Certidão de Nascimento</b> está pendente.');
    lines.push('');
    lines.push('📋 Assim que o bebê nascer, será necessário enviar');
    lines.push('a certidão para que o INSS aceite sem colocar em exigências.');
    lines.push('');
    lines.push('📺 <b>Guia de como enviar a certidão corretamente:</b>');
    lines.push(`<a href="https://vimeo.com/1177468232?share=copy&fl=sv&fe=ci">📺 Tutorial em vídeo</a>`);
  }

  return lines.join('\n');
}

/**
 * Gera o bloco especial de perícia médica para exibição ao cliente.
 * Inclui local, data/hora, e orientações detalhadas.
 * @param {object} deal
 * @param {string} clientName - Nome do cliente
 * @returns {string} Texto formatado em HTML
 */
export function formatPericiaBlock(deal, clientName) {
  const lines = [];
  const servico = resolveEnum(deal.UF_CRM_1731420853730, SERVICO_ENUM) || '';
  const nome = clientName || 'Cliente';

  lines.push('');
  lines.push('🏥 <b>═══ PERÍCIA MÉDICA MARCADA ═══</b>');
  lines.push('');
  lines.push(`👤 <b>${nome}</b>, temos uma notícia importante sobre seu benefício!`);
  lines.push('');
  lines.push('🔬 <b>Seu INSS agendou a perícia médica.</b>');
  lines.push('📋 Veja os detalhes abaixo:');
  lines.push('');

  // ── Informações da Perícia
  lines.push('📅 <b>━━━ DADOS DA PERÍCIA ━━━</b>');
  lines.push('');

  if (servico) {
    lines.push(`🎯 <b>Benefício:</b> ${servico}`);
  }

  const dataHora = deal.UF_CRM_1747855086;
  if (dataHora) {
    const d = new Date(dataHora);
    const dataStr = d.toLocaleDateString('pt-BR', { timeZone: 'America/Cuiaba', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    const horaStr = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Cuiaba', hour: '2-digit', minute: '2-digit' });
    lines.push(`📆 <b>Data:</b> ${dataStr}`);
    lines.push(`⏰ <b>Horário:</b> ${horaStr}`);
  }

  const localPericia = deal.UF_CRM_1747840589237;
  if (localPericia) {
    lines.push(`📍 <b>Local:</b> ${localPericia}`);
  }

  lines.push('');

  // ── Orientações para a Perícia
  lines.push('📝 <b>━━━ ORIENTAÇÕES ━━━</b>');
  lines.push('');
  lines.push('✅ Explique ao perito todas as suas sequelas e dificuldades');
  lines.push('✅ Mencione especialmente as limitações no trabalho');
  lines.push('✅ Siga rigorosamente as orientações do advogado');
  lines.push('');
  lines.push('🎥 <b>Assista este vídeo preparatório:</b>');
  lines.push(`<a href="https://vimeo.com/1116167265?share=copy">▶️ Clique aqui para assistir</a>`);
  lines.push('');

  // ── Documentos
  lines.push('📄 <b>━━━ DOCUMENTOS NECESSÁRIOS ━━━</b>');
  lines.push('');
  lines.push('🔹 Documento de identidade com foto');
  lines.push('🔹 Todos os laudos e exames médicos');
  lines.push('🔹 Receitas e atestados médicos');
  lines.push('🔹 Comprovante de agendamento (se houver)');
  lines.push('');

  // ── Contato
  lines.push('📞 <b>━━━ CANAIS DE ATENDIMENTO ━━━</b>');
  lines.push('');
  lines.push(`☎️ Fixo: <b>(65) 3052-5278</b>`);
  lines.push(`📱 WhatsApp: <a href="https://wa.me/556530525278">Clique aqui</a>`);
  lines.push(`📍 Escritório: <a href="https://maps.app.goo.gl/AaeyASErJLHjosk39">Ver no mapa</a>`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Gera um slot de agendamento na sala Orientação Perícia Cbá.
 * Retorna 3 opções no próximo dia útil.
 * @param {Array} existingBookings
 * @returns {Array}
 */
export function generatePericiaSlots(existingBookings = []) {
  const slots = [];
  const now = new Date();
  const timezone = 'America/Cuiaba';
  const roomName = 'Orientação Perícia Cbá';

  // Descobrir "hoje" no timezone Cuiabá
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);

  const getPart = (type) => nowParts.find(p => p.type === type).value;
  const todayCuiaba = new Date(`${getPart('year')}-${getPart('month').padStart(2, '0')}-${getPart('day').padStart(2, '0')}T12:00:00`);
  const startDate = new Date(todayCuiaba);
  startDate.setDate(startDate.getDate() + 1);

  while (startDate.getDay() === 0 || startDate.getDay() === 6) {
    startDate.setDate(startDate.getDate() + 1);
  }

  const year = startDate.getFullYear();
  const month = startDate.getMonth() + 1;
  const day = startDate.getDate();

  const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const monthNames = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const dayName = dayNames[startDate.getDay()];
  const monthName = monthNames[startDate.getMonth()];
  const dayNum = day;

  const availableHours = [
    [8, 0], [8, 30], [9, 0], [9, 30], [10, 0], [10, 30], [11, 0], [11, 30],
    [13, 0], [13, 30], [14, 0], [14, 30], [15, 0], [15, 30], [16, 0], [16, 30], [17, 0], [17, 30],
  ];

  for (const [hour, min] of availableHours) {
    if (slots.length >= 3) break;

    const slotStart = createDateInTZ(timezone, year, month, day, hour, min);
    const slotEnd = createDateInTZ(timezone, year, month, day, hour, min + 30);

    const fromTs = Math.floor(slotStart.getTime() / 1000);
    const toTs = Math.floor(slotEnd.getTime() / 1000);

    const hasConflict = existingBookings.some(booking => {
      if (!booking.resourceIds?.includes(PERICIA_ROOM_ID)) return false;
      const bookingFrom = parseInt(booking.datePeriod?.from?.timestamp || 0);
      const bookingTo = parseInt(booking.datePeriod?.to?.timestamp || 0);
      return fromTs < bookingTo && toTs > bookingFrom;
    });

    if (!hasConflict) {
      const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      slots.push({
        fromTs,
        toTs,
        from: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${timeStr}:00`,
        to: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min + 30).padStart(2, '0')}:00`,
        label: `${dayName}, ${dayNum} de ${monthName} às ${timeStr}`,
        resourceId: PERICIA_ROOM_ID,
        roomName,
      });
    }
  }

  return slots;
}

// ---------------------------------------------------------------------------
// 12. Alerta de chamada (Bitrix24 IM)
// ---------------------------------------------------------------------------
// IDs dos destinatários de alerta de chamada
const ALERT_DESTINATIONS = Object.freeze({
  generalChat: 'chat1',        // Chat geral
  rodrigo: '1',                // Rodrigo (user ID)
  larissa: '76239',            // Larissa (user ID)
});
const ALERT_REPEAT = 3;        // Enviar 3 vezes consecutivas

/**
 * Envia uma mensagem no IM do Bitrix24 (chat geral ou DM de usuário).
 * @param {string} dialogId - ID do dialog (ex: 'chat1', '1', '76239')
 * @param {string} message - Texto da mensagem (BBCode)
 * @returns {Promise<object>}
 */
export async function sendBitrix24Message(dialogId, message) {
  return bxCall('/im.message.add.json', {
    DIALOG_ID: dialogId,
    MESSAGE: message,
  });
}

/**
 * Envia alerta de manutenção de chamada para chat geral, Rodrigo e Larissa.
 * Envia 3 vezes consecutivas para cada destinatário.
 * @param {object} params
 * @param {string} params.clientName - Nome do cliente
 * @param {string} params.clientPhone - Telefone informado pelo cliente
 * @param {string} params.contactLink - Link do contato no CRM
 */
export async function sendCallMaintenanceAlert({ clientName, clientPhone, contactLink }) {
  const alertMsg = [
    '[B]⚠️🚨 ATENÇÃO: Sistema de chamadas em manutenção! 🚨⚠️[/B]',
    '',
    `[B]Cliente:[/B] ${clientName || 'Não identificado'}`,
    `[B]Telefone:[/B] ${clientPhone || 'Não informado'}`,
    `[B]Link do cadastro:[/B] ${contactLink || 'Não disponível'}`,
    '',
    '[B]Ação:[/B] Solicitou chamada via bot Telegram',
    '[B]Prioridade:[/B] ALTA — retornar o mais breve possível!',
    '',
    '[I]Este alerta será repetido 3 vezes.[/I]',
  ].join('\n');

  const destinations = [
    ALERT_DESTINATIONS.generalChat,
    ALERT_DESTINATIONS.rodrigo,
    ALERT_DESTINATIONS.larissa,
  ];

  console.log(`[ALERT] Iniciando envio de alerta para ${destinations.length} destinatários...`);

  for (const dialogId of destinations) {
    for (let i = 0; i < ALERT_REPEAT; i++) {
      try {
        console.log(`[ALERT] Enviando para ${dialogId} (tentativa ${i + 1}/${ALERT_REPEAT})`);
        await sendBitrix24Message(dialogId, alertMsg);
        console.log(`[ALERT] ✅ Enviado para ${dialogId} (tentativa ${i + 1})`);
        // Pequeno delay entre envios para não sobrecarregar
        if (i < ALERT_REPEAT - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (err) {
        console.error(`[ALERT] ❌ Falha para ${dialogId} (tentativa ${i + 1}): ${err.message}`);
        logger.warn(`[Bitrix24] Falha ao enviar alerta para ${dialogId} (tentativa ${i + 1}): ${err.message}`);
      }
    }
  }

  console.log(`[ALERT] Envio de alertas finalizado.`);
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

// ---------------------------------------------------------------------------
// updateContact — atualiza campos do contato no CRM
// ---------------------------------------------------------------------------

/**
 * Atualiza um contato existente no CRM Bitrix24.
 * @param {number} contactId - ID do contato
 * @param {object} fields - Campos para atualizar
 * @returns {Promise<boolean>}
 */
export async function updateContact(contactId, fields = {}) {
  if (!contactId || Object.keys(fields).length === 0) return false;
  try {
    await bxCall('/crm.contact.update.json', {
      id: contactId,
      fields,
    });
    return true;
  } catch (err) {
    logger.error(`[Bitrix24] Falha ao atualizar contato ${contactId}: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// postToWorkgroup — criar post no feed de um workgroup
// ---------------------------------------------------------------------------

/**
 * Cria um post no feed de um workgroup no Bitrix24.
 * @param {number} groupId - ID do workgroup
 * @param {string} title - Título do post
 * @param {string} message - Mensagem do post (suporta BB codes)
 * @returns {Promise<object>}
 */
export async function postToWorkgroup(groupId, title, message) {
  return bxCall('/log.blogpost.add.json', {
    POST_TITLE: title,
    POST_MESSAGE: message,
    ENTITY_TYPE: 'SG',
    ENTITY_ID: groupId,
  });
}
