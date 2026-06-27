// =============================================================================
// server.js — Hermes Bot
// Servidor Express que recebe webhooks do Telegram, orquestra a máquina
// de estados da conversa e integra com o CRM Bitrix24.
//
// Brandão Correa Assessoria Jurídica — 2026
// =============================================================================

import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import config from './config/index.js';
import { logger, createLogger } from './utils/logger.js';
import { requestIdMiddleware } from './utils/requestId.js';

// -- Serviços internos
import * as telegram from './services/telegram.js';
import * as bitrix24 from './services/bitrix24.js';
import * as hermesAI from './services/hermesAI.js';

// -- Gerenciamento de sessão (máquina de estados)
import {
  State,
  getSession,
  updateSession,
  appendHistory,
  deleteSession,
  activeSessionCount,
  destroySessionCleanup,
} from './middleware/session.js';

// =============================================================================
// Constantes
// =============================================================================

const CALLBACK = Object.freeze({
  MENU_STATUS: 'MENU_STATUS',
  MENU_AGENDAMENTO: 'MENU_AGENDAMENTO',
  MENU_CHAMADA: 'MENU_CHAMADA',
  MENU_FALAR_EQUIPE: 'MENU_FALAR_EQUIPE',
  MENU_VOLTAR: 'MENU_VOLTAR',
  CONFIRM_CPF: 'CONFIRM_CPF',
});

const FALLBACK_PHONE = config.fallback.phone;

// =============================================================================
// Configuração do Express
// =============================================================================

const app = express();

// -- Segurança básica
app.use(helmet());

// -- Request ID (propagado em logs e chamadas downstream)
app.use(requestIdMiddleware);

// -- Rate limiters separados: Telegram (lax) vs Bitrix24 webhooks (restritivo)
const telegramLimiter = rateLimit({
  windowMs: config.rateLimit.telegramWindowMs,
  max: config.rateLimit.telegramMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde um momento.' },
});

const bitrix24Limiter = rateLimit({
  windowMs: config.rateLimit.bitrix24WindowMs,
  max: config.rateLimit.bitrix24Max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit excedido.' },
});

// -- Parsing do corpo da requisição (JSON)
app.use(express.json());

// -- Logging básico com requestId
app.use((req, _res, next) => {
  const log = createLogger(req.requestId);
  log.info(`${req.method} ${req.path}`);
  next();
});

// =============================================================================
// Rota: Health Check
// =============================================================================

app.get('/health', async (_req, res) => {
  const bxAlive = await bitrix24.pingBitrix24();
  res.json({
    status: 'ok',
    service: 'Hermes Bot',
    version: '1.0.0',
    uptime: process.uptime(),
    activeSessions: activeSessionCount(),
    bitrix24: bxAlive ? 'connected' : 'unreachable',
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// Rota: Webhook do Telegram (ponto de entrada principal)
// =============================================================================

app.post('/webhook/telegram', telegramLimiter, async (req, res) => {
  const log = createLogger(req.requestId);

  // -- Verificação do secret token (proteção contra forjamento)
  if (!telegram.isValidWebhookSecret(req)) {
    log.warn('Webhook Telegram rejeitado: secret token inválido.');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Responde imediatamente com 200 OK para o Telegram não reenviar
  res.sendStatus(200);

  try {
    await handleTelegramUpdate(req.body, req.requestId);
  } catch (err) {
    log.error(`Erro crítico no processamento do webhook: ${err.message}`, { stack: err.stack });
    // Tenta notificar o usuário sobre a falha, se possível
    try {
      const extracted = telegram.extractPayload(req.body);
      if (extracted.chatId) {
        await telegram.sendMessage(
          extracted.chatId,
          `⚠️ No momento nosso sistema de consultas está em manutenção. ` +
            `Por favor, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>. ` +
            `Pedimos desculpas pelo inconveniente.`
        );
      }
    } catch (fallbackErr) {
      log.error(`Falha ao enviar mensagem de fallback: ${fallbackErr.message}`);
    }
  }
});

// =============================================================================
// Rota: Webhook do Bitrix24 (eventos reversos do CRM)
// =============================================================================

app.post('/webhook/bitrix24', bitrix24Limiter, async (req, res) => {
  const log = createLogger(req.requestId);
  res.sendStatus(200);

  try {
    const event = req.body;
    log.info(`Evento Bitrix24 recebido: ${event?.event}`);

    if (event?.event === 'ONIMOPENLINESSESSIONSTART') {
      // Armazenar sessionId para uso posterior em assignChatToOperator
      log.info(`[Bitrix24] Sessão Open Channel iniciada: ${event.data?.SESSION_ID}`);
    } else if (event?.event === 'ONIMOPENLINESSESSIONFINISH') {
      log.info('[Bitrix24] Sessão de Open Channel finalizada.');
    }
  } catch (err) {
    log.error(`Erro ao processar webhook do Bitrix24: ${err.message}`);
  }
});

// =============================================================================
// LÓGICA PRINCIPAL: Máquina de estados da conversa
// =============================================================================

/**
 * Roteador principal — recebe o payload do Telegram e decide a ação.
 * @param {object} body
 * @param {string} [requestId]
 */
async function handleTelegramUpdate(body, requestId) {
  const log = createLogger(requestId);
  const extracted = telegram.extractPayload(body);
  const { chatId, text, contact, callbackData, callbackQueryId, messageId, firstName, lastName, username } = extracted;

  if (!chatId) {
    log.info('Payload sem chatId — ignorado.');
    return;
  }

  const session = getSession(chatId);

  if (text) {
    appendHistory(chatId, 'user', text);
  }

  // -- Callback query (botão inline)
  if (callbackData && callbackQueryId) {
    await telegram.answerCallbackQuery(callbackQueryId);
    await handleCallback(chatId, callbackData, messageId, session, log);
    return;
  }

  // -- Comando /start
  if (text === '/start') {
    await handleStart(chatId, firstName);
    return;
  }

  // -- Contato compartilhado
  if (contact && contact.phone_number) {
    await handleContactReceived(chatId, contact.phone_number, session, log);
    return;
  }

  // -- Roteamento baseado no estado atual
  switch (session.state) {
    case State.IDLE:
      await handleIdle(chatId, text, firstName);
      break;

    case State.AWAITING_CPF:
      await handleAwaitingCpf(chatId, text, firstName, log);
      break;

    case State.AWAITING_NAME:
      await handleAwaitingName(chatId, text, log);
      break;

    case State.AUTHENTICATED:
      await handleAuthenticated(chatId, text, session, log);
      break;

    case State.AWAITING_STATUS_CPF:
      await handleStatusLookup(chatId, text, log);
      break;

    case State.AWAITING_CALLBACK_DETAILS:
      await handleCallbackDetails(chatId, text, log);
      break;

    case State.HANDOFF:
      await handleHandoffState(chatId, text);
      break;

    default:
      updateSession(chatId, State.IDLE);
      await handleIdle(chatId, text, firstName);
  }
}

// =============================================================================
// HANDLERS DE CALLBACK (botões inline)
// =============================================================================

async function handleCallback(chatId, callbackData, messageId, session, log) {
  switch (callbackData) {
    case CALLBACK.MENU_STATUS:
      await promptForStatusCpf(chatId);
      break;

    case CALLBACK.MENU_AGENDAMENTO:
      await handleAgendamento(chatId, session);
      break;

    case CALLBACK.MENU_CHAMADA:
      await promptForCallbackDetails(chatId);
      break;

    case CALLBACK.MENU_FALAR_EQUIPE:
      await handleHandoff(chatId, session, log);
      break;

    case CALLBACK.MENU_VOLTAR:
      await showMainMenu(chatId, getSession(chatId));
      break;

    default:
      log.info(`Callback desconhecido: ${callbackData}`);
      await showMainMenu(chatId, session);
  }
}

// =============================================================================
// HANDLERS DE ESTADO
// =============================================================================

// ---------------------------------------------------------------------------
// FASE 1: Reconhecimento Inicial
// ---------------------------------------------------------------------------

async function handleIdle(chatId, _text, firstName) {
  const greeting = firstName ? `Olá, ${firstName}!` : 'Olá!';
  await telegram.sendMessage(
    chatId,
    `${greeting} 👋 Bem-vindo(a) à <b>Brandão Correa Assessoria Jurídica</b>.\n\n` +
      `Eu sou o <b>Hermes</b>, seu assistente virtual. Estou aqui para ajudar com:\n` +
      `• Consulta de processos\n` +
      `• Agendamento de horários\n` +
      `• Solicitação de chamadas\n` +
      `• Atendimento com nossa equipe\n\n` +
      `Para começar, precisamos identificar você.`
  );

  await telegram.requestContact(
    chatId,
    '📱 Para prosseguir, por favor compartilhe seu número de telefone clicando no botão abaixo:'
  );

  await telegram.sendMessage(
    chatId,
    'Paralelamente, por favor informe seu <b>CPF</b> (apenas números) para consultarmos seu cadastro:'
  );

  updateSession(chatId, State.AWAITING_CPF);
}

// ---------------------------------------------------------------------------
// FASE 1b: Recebimento do Contato do Telegram
// ---------------------------------------------------------------------------

async function handleContactReceived(chatId, phoneNumber, session, log) {
  const cleanPhone = phoneNumber.replace(/\D/g, '');
  const updated = updateSession(chatId, session.state, { phone: cleanPhone });

  await telegram.removeKeyboard(chatId, '✅ Número recebido! Obrigado.');

  // Re-busca a sessão atualizada para evitar stale reference
  if (updated.cpf) {
    await authenticateClient(chatId, updated, log);
  }
}

// ---------------------------------------------------------------------------
// FASE 1c: Aguardando CPF
// ---------------------------------------------------------------------------

async function handleAwaitingCpf(chatId, text, _firstName, log) {
  const cpfFromMessage = hermesAI.extractCpf(text);

  if (!cpfFromMessage || !hermesAI.isValidCpf(cpfFromMessage)) {
    await telegram.sendMessage(
      chatId,
      '❌ Não consegui identificar um CPF válido na sua mensagem.\n\n' +
        'Por favor, informe seu <b>CPF</b> com 11 dígitos (ex: 123.456.789-00):'
    );
    return;
  }

  // Atualiza a sessão E re-busca a referência fresca
  const updated = updateSession(chatId, State.AWAITING_CPF, { cpf: cpfFromMessage });
  appendHistory(chatId, 'system', `CPF validado: ${cpfFromMessage}`);

  await telegram.sendMessage(chatId, '✅ CPF recebido! Estou consultando seu cadastro...');

  // Usa a referência atualizada — não a "session" original (stale)
  if (updated.phone) {
    await authenticateClient(chatId, updated, log);
  } else {
    await telegram.requestContact(
      chatId,
      'Agora, por favor compartilhe seu <b>número de telefone</b> para confirmarmos sua identidade:'
    );
  }
}

// ---------------------------------------------------------------------------
// FASE 1d: Aguardando Nome (para novos clientes)
// ---------------------------------------------------------------------------

async function handleAwaitingName(chatId, text, log) {
  const name = (text || '').trim();
  if (name.length < 2) {
    await telegram.sendMessage(chatId, 'Por favor, informe seu <b>nome completo</b>:');
    return;
  }

  const updated = updateSession(chatId, State.AUTHENTICATED, { name });

  if (updated._pendingCreate) {
    try {
      await telegram.sendMessage(chatId, '📝 Criando seu cadastro no sistema...');

      const { contactId, dealId } = await bitrix24.createContactAndDeal({
        name,
        phone: updated.phone || undefined,
        cpf: updated.cpf || undefined,
      });

      updateSession(chatId, State.AUTHENTICATED, {
        crmContactId: contactId,
        crmDealId: dealId,
        _pendingCreate: false,
      });

      await telegram.sendMessage(
        chatId,
        `✅ Cadastro criado com sucesso, <b>${name}</b>!\n` +
          `Seu registro já está em nosso sistema jurídico.`
      );
    } catch (err) {
      log.error(`Erro ao criar Contato+Negócio: ${err.message}`);

      // Fallback: tenta criar apenas um Lead
      try {
        const leadId = await bitrix24.createLead({
          name,
          phone: updated.phone || undefined,
          cpf: updated.cpf || undefined,
        });

        updateSession(chatId, State.AUTHENTICATED, {
          crmContactId: leadId,
          _pendingCreate: false,
        });

        await telegram.sendMessage(
          chatId,
          `✅ Cadastro criado, <b>${name}</b>! Nossa equipe entrará em contato em breve.`
        );
      } catch (leadErr) {
        log.error(`Erro ao criar Lead (fallback): ${leadErr.message}`);
        await telegram.sendMessage(
          chatId,
          `⚠️ Tivemos uma dificuldade ao criar seu cadastro, mas você já pode usar nosso atendimento.\n` +
            `Para agilizar, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
        );
        updateSession(chatId, State.AUTHENTICATED, { _pendingCreate: false });
      }
    }
  } else {
    await telegram.sendMessage(
      chatId,
      `Obrigado, <b>${name}</b>! Seus dados estão confirmados.`
    );
  }

  await showMainMenu(chatId, getSession(chatId));
}

// ---------------------------------------------------------------------------
// FASE 1e: Autenticação contra o CRM
// ---------------------------------------------------------------------------

async function authenticateClient(chatId, session, log) {
  try {
    await telegram.sendMessage(chatId, '🔍 Consultando nosso sistema...');

    const [contacts, leads] = await Promise.all([
      bitrix24.findContactByCpfOrPhone({ cpf: session.cpf, phone: session.phone }),
      bitrix24.findLeadByCpfOrPhone({ cpf: session.cpf, phone: session.phone }),
    ]);

    const foundContact = contacts?.[0];
    const foundLead = leads?.[0];

    if (foundContact) {
      const contactName =
        [foundContact.NAME, foundContact.LAST_NAME].filter(Boolean).join(' ') || 'Cliente';
      const authenticated = updateSession(chatId, State.AUTHENTICATED, {
        name: contactName,
        crmContactId: foundContact.ID,
      });

      await telegram.sendMessage(
        chatId,
        `✅ <b>Identidade confirmada!</b>\nBem-vindo(a) de volta, ${contactName}.`
      );

      const deals = await bitrix24.getDealsByContact(foundContact.ID);
      if (deals.length > 0) {
        updateSession(chatId, State.AUTHENTICATED, { crmDealId: deals[0].ID });
      }

      await showMainMenu(chatId, getSession(chatId));
    } else if (foundLead) {
      const leadName = foundLead.NAME || foundLead.TITLE || 'Cliente';
      updateSession(chatId, State.AUTHENTICATED, {
        name: leadName,
        crmContactId: foundLead.ID,
      });

      await telegram.sendMessage(
        chatId,
        `✅ <b>Cadastro localizado!</b>\nBem-vindo(a), ${leadName}.`
      );
      await showMainMenu(chatId, getSession(chatId));
    } else {
      // -- Cliente NOVO
      await telegram.sendMessage(
        chatId,
        '🆕 Não encontramos seu cadastro em nosso sistema. Vou criar seu registro agora.\n\n' +
          'Por favor, me informe seu <b>nome completo</b>:'
      );

      updateSession(chatId, State.AWAITING_NAME, {
        crmContactId: null,
        crmDealId: null,
        _pendingCreate: true,
      });
    }
  } catch (err) {
    log.error(`Erro ao consultar CRM: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ No momento nosso sistema de consultas está em manutenção. ` +
        `Por favor, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
    );
  }
}

// =============================================================================
// FASE 2: Menu Principal e Interações Autenticadas
// =============================================================================

async function handleAuthenticated(chatId, text, session, log) {
  const { intent, confidence } = await hermesAI.classifyIntent(text, session.history || []);

  log.info(`Intenção: ${intent} (confiança: ${(confidence * 100).toFixed(0)}%)`);

  switch (intent) {
    case hermesAI.Intent.STATUS_PROCESSO:
      await promptForStatusCpf(chatId);
      break;

    case hermesAI.Intent.AGENDAMENTO:
      await handleAgendamento(chatId, session);
      break;

    case hermesAI.Intent.SOLICITAR_CHAMADA:
      await promptForCallbackDetails(chatId);
      break;

    case hermesAI.Intent.FALAR_EQUIPE:
    case hermesAI.Intent.DUVIDA_COMPLEXA:
      await handleHandoff(chatId, session, log);
      break;

    case hermesAI.Intent.SAUDACAO:
      await telegram.sendMessage(
        chatId,
        `Olá novamente, <b>${session.name || 'cliente'}</b>! Como posso ajudar?`
      );
      await showMainMenu(chatId, session);
      break;

    case hermesAI.Intent.MENU_PRINCIPAL:
      await showMainMenu(chatId, session);
      break;

    case hermesAI.Intent.FORNECER_CPF:
      await telegram.sendMessage(
        chatId,
        'Seu CPF já foi registrado nesta conversa. Como posso ajudar?'
      );
      await showMainMenu(chatId, session);
      break;

    default:
      await telegram.sendMessage(
        chatId,
        'Não entendi exatamente o que você precisa. Aqui estão as opções disponíveis:'
      );
      await showMainMenu(chatId, session);
  }
}

// ---------------------------------------------------------------------------
// Menu Principal (inline keyboard)
// ---------------------------------------------------------------------------

async function showMainMenu(chatId, session) {
  const name = session.name || 'Cliente';

  const buttons = [
    [{ text: '📋 Status do Processo', callback_data: CALLBACK.MENU_STATUS }],
    [{ text: '📅 Agendamento de Horário', callback_data: CALLBACK.MENU_AGENDAMENTO }],
    [{ text: '📞 Solicitar uma Chamada', callback_data: CALLBACK.MENU_CHAMADA }],
    [{ text: '👩‍💼 Falar com a Equipe', callback_data: CALLBACK.MENU_FALAR_EQUIPE }],
  ];

  await telegram.sendInlineKeyboard(
    chatId,
    `📌 <b>Menu Principal</b> — ${name}, como posso ajudar?\n\n` +
      `<i>Você pode clicar nos botões abaixo ou digitar sua necessidade em texto livre:</i>`,
    buttons
  );

  updateSession(chatId, State.AUTHENTICATED);
}

// =============================================================================
// OPÇÃO 1: Status do Processo
// =============================================================================

async function promptForStatusCpf(chatId) {
  updateSession(chatId, State.AWAITING_STATUS_CPF);

  await telegram.sendMessage(
    chatId,
    '📋 <b>Consulta de Processo</b>\n\n' +
      'Por favor, informe o <b>CPF</b> associado ao processo que deseja consultar:'
  );
}

async function handleStatusLookup(chatId, text, log) {
  const cpf = hermesAI.extractCpf(text);

  if (!cpf) {
    await telegram.sendMessage(
      chatId,
      'Por favor, informe um <b>CPF válido</b> (11 dígitos) para consulta:'
    );
    return;
  }

  try {
    await telegram.sendMessage(chatId, '🔍 Consultando processos...');

    const contacts = await bitrix24.findContactByCpfOrPhone({ cpf });
    const contact = contacts?.[0];

    if (!contact) {
      await telegram.sendMessage(
        chatId,
        '❌ Não encontramos processos vinculados a este CPF.\n\n' +
          'Verifique se o número está correto ou entre em contato pelo telefone/WhatsApp: ' +
          `<b>${FALLBACK_PHONE}</b>.`
      );
      updateSession(chatId, State.AUTHENTICATED);
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    const deals = await bitrix24.getDealsByContact(contact.ID);

    if (!deals || deals.length === 0) {
      await telegram.sendMessage(
        chatId,
        'ℹ️ Não há processos ativos vinculados ao seu CPF no momento.\n\n' +
          'Se acredita que isso é um erro, por favor entre em contato com nossa equipe.'
      );
    } else {
      const dealList = deals
        .map((deal, i) => {
          const date = deal.DATE_CREATE
            ? new Date(deal.DATE_CREATE).toLocaleDateString('pt-BR')
            : 'N/D';
          return (
            `<b>${i + 1}.</b> ${deal.TITLE || 'Sem título'}\n` +
            `    📌 Estágio: <b>${deal.STAGE_ID || 'Não informado'}</b>\n` +
            `    📅 Abertura: ${date}`
          );
        })
        .join('\n\n');

      await telegram.sendMessage(
        chatId,
        `📋 <b>Processos Encontrados</b>\n\n${dealList}\n\n` +
          `<i>Para mais detalhes sobre um processo específico, entre em contato com nossa equipe.</i>`
      );
    }

    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  } catch (err) {
    log.error(`Erro ao consultar processos: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ No momento nosso sistema de consultas está em manutenção. ` +
        `Por favor, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
    );
    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  }
}

// =============================================================================
// OPÇÃO 2: Agendamento de Horário
// =============================================================================

async function handleAgendamento(chatId, session) {
  try {
    const bookingLink = bitrix24.getBookingLink();

    await telegram.sendMessage(
      chatId,
      '📅 <b>Agendamento de Horário</b>\n\n' +
        `Para agendar uma consulta, acesse nossa agenda online:\n` +
        `<a href="${bookingLink}">📆 Agenda Online — Brandão Correa</a>\n\n` +
        `<i>Ao clicar no link, você poderá escolher o melhor dia e horário disponível.</i>`
    );

    const slots = await bitrix24.getAvailableSlots();
    if (slots && slots.length > 0) {
      const slotInfo = slots
        .slice(0, 5)
        .map((s) => `• ${s.NAME || 'Horário disponível'}`)
        .join('\n');
      await telegram.sendMessage(
        chatId,
        `📆 <b>Próximos horários disponíveis:</b>\n${slotInfo}`
      );
    }
  } catch (err) {
    logger.error(`[Agendamento] Erro: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ No momento o sistema de agendamento está em manutenção. ` +
        `Por favor, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
    );
  }

  await showMainMenu(chatId, session);
}

// =============================================================================
// OPÇÃO 3: Solicitar uma Chamada
// =============================================================================

async function promptForCallbackDetails(chatId) {
  updateSession(chatId, State.AWAITING_CALLBACK_DETAILS);

  await telegram.sendMessage(
    chatId,
    '📞 <b>Solicitação de Chamada</b>\n\n' +
      'Por favor, informe:\n' +
      '• O <b>número de telefone</b> para retorno\n' +
      '• Seu <b>melhor horário</b> para receber a ligação\n\n' +
      '<i>Exemplo: "11 99999-8888, amanhã entre 14h e 16h"</i>'
  );
}

async function handleCallbackDetails(chatId, text, log) {
  try {
    await telegram.sendMessage(chatId, '📞 Registrando sua solicitação de chamada...');

    const phoneMatch = text.match(/(\d{2}\s?\d{4,5}-?\d{4})/);
    const session = getSession(chatId);
    const callbackPhone = phoneMatch ? phoneMatch[1] : session.phone || 'Não informado';

    await bitrix24.createCallActivity({
      ownerId: config.bitrix24.operatorAliceId,
      contactId: session.crmContactId || undefined,
      dealId: session.crmDealId || undefined,
      phone: callbackPhone,
    });

    await telegram.sendMessage(
      chatId,
      '✅ <b>Solicitação registrada com sucesso!</b>\n\n' +
        `Nossa equipe entrará em contato pelo telefone <b>${callbackPhone}</b>.\n` +
        `⏰ Prioridade <b>Alta</b> — retornaremos o mais breve possível.\n\n` +
        `<i>Detalhes da sua solicitação: "${text}"</i>`
    );
  } catch (err) {
    log.error(`Erro ao registrar atividade de chamada: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ No momento o sistema de registro de chamadas está em manutenção. ` +
        `Por favor, entre em contato diretamente pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
    );
  }

  updateSession(chatId, State.AUTHENTICATED);
  await showMainMenu(chatId, getSession(chatId));
}

// =============================================================================
// OPÇÃO 4: Falar com a Equipe (Transbordo / Handoff)
// =============================================================================

/**
 * Executa o protocolo de transbordo para a operadora Alice via Open Channels.
 */
async function handleHandoff(chatId, session, log) {
  try {
    await telegram.sendMessage(
      chatId,
      '🔄 <b>Transferindo para atendimento humano...</b>\n\n' +
        'Você será atendido(a) por nossa equipe em instantes. ' +
        'Enquanto isso, pode continuar descrevendo sua necessidade.'
    );

    updateSession(chatId, State.HANDOFF);

    const summary = await hermesAI.generateSummary(session.history || []);

    // Whisper no Open Channel — usa BBCode (não HTML) para o Bitrix24 IM
    const dialogId = `chat${chatId}`;
    const whisperMessage = [
      '[B]🤖 Resumo Hermes — Atendimento Telegram[/B]',
      '',
      `[B]Cliente:[/B] ${session.name || 'Não identificado'}`,
      `[B]CPF:[/B] ${session.cpf || 'Não informado'}`,
      `[B]Telefone:[/B] ${session.phone || 'Não informado'}`,
      '',
      '[B]📋 Resumo da conversa:[/B]',
      summary,
      '',
      `[I]Gerado automaticamente pelo Hermes. ${new Date().toLocaleString('pt-BR')}[/I]`,
    ].join('\n');

    try {
      await bitrix24.sendWhisperMessage({ dialogId, message: whisperMessage });
    } catch (whisperErr) {
      log.warn(`Whisper message falhou (continuando): ${whisperErr.message}`);
    }

    // Notificação BBCode para Alice
    await bitrix24.notifyOperator({
      operatorId: config.bitrix24.operatorAliceId,
      clientName: session.name || 'Cliente não identificado',
      clientCpf: session.cpf || undefined,
      summary,
    });

    // Transferência automática — exige SESSION_ID (obtido via webhook Bitrix24)
    // Se não temos sessionId, o operador atende manualmente após notificação.
    try {
      await bitrix24.assignChatToOperator({
        chatId: dialogId,
        sessionId: session.bxSessionId, // Pode ser undefined — fallback manual
        operatorId: config.bitrix24.operatorAliceId,
      });
    } catch (transferErr) {
      log.warn(`Transferência automática indisponível: ${transferErr.message}`);
    }

    await telegram.sendMessage(
      chatId,
      '✅ <b>Você está na fila de atendimento humano.</b>\n\n' +
        'Nossa equipe já foi notificada e entrará em contato em breve. ' +
        'Se preferir, também pode nos ligar: ' +
        `<b>${FALLBACK_PHONE}</b>.\n\n` +
        '<i>Obrigado pela paciência!</i>'
    );

    appendHistory(chatId, 'system', 'Handoff para Alice concluído.');
  } catch (err) {
    log.error(`Erro no transbordo: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ Encontramos uma dificuldade ao transferir seu atendimento. ` +
        `Por favor, entre em contato diretamente pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
    );
  }
}

// ---------------------------------------------------------------------------
// Estado HANDOFF
// ---------------------------------------------------------------------------

async function handleHandoffState(chatId, _text) {
  await telegram.sendMessage(
    chatId,
    'Você está na fila de atendimento humano. Nossa equipe já foi notificada e ' +
      'entrará em contato em breve. Se for urgente, ligue para ' +
      `<b>${FALLBACK_PHONE}</b>.`
  );
}

// =============================================================================
// HANDLER: /start
// =============================================================================

async function handleStart(chatId, firstName) {
  deleteSession(chatId);
  getSession(chatId); // Cria nova sessão limpa
  await handleIdle(chatId, null, firstName);
}

// =============================================================================
// Inicialização do Servidor + Graceful Shutdown
// =============================================================================

const PORT = config.port;

const server = app.listen(PORT, () => {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  🤖 Hermes Bot — Brandão Correa Assessoria');
  console.log('══════════════════════════════════════════════');
  console.log(`  Servidor:  http://localhost:${PORT}`);
  console.log(`  Webhook:   http://localhost:${PORT}/webhook/telegram`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  Ambiente:  ${config.nodeEnv}`);
  console.log(`  Bitrix24:  ${config.bitrix24.domain}`);
  console.log(`  IA Ativa:  ${config.hermesAI.apiKey ? 'Sim' : 'Não (regex fallback)'}`);
  console.log(`  Secret:    ${config.telegram.webhookSecretToken ? 'Sim' : 'Não (inseguro!)'}`);
  console.log('══════════════════════════════════════════════');
  console.log('');
});

// -- Graceful shutdown
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Recebido ${signal} — encerrando graciosamente...`);

  // Para de aceitar novas conexões
  server.close((err) => {
    if (err) logger.error(`Erro ao fechar servidor: ${err.message}`);
    else logger.info('Servidor HTTP fechado.');

    // Limpa intervalo de sessões
    destroySessionCleanup();

    logger.info('Shutdown completo. Adeus! 👋');
    process.exit(err ? 1 : 0);
  });

  // Force-exit após 10s se algo travar
  setTimeout(() => {
    logger.error('Timeout no graceful shutdown — forçando exit.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// -- Tratamento de erros não capturados (não derruba o processo, mas loga)
process.on('uncaughtException', (err) => {
  logger.error(`[FATAL] Uncaught Exception: ${err.message}`, { stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error(`[FATAL] Unhandled Rejection: ${reason}`);
});

export default app;
