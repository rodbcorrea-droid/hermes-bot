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
  MENU_BOLETO: 'MENU_BOLETO',
  MENU_PERICIA: 'MENU_PERICIA',
  MENU_DOCUMENTOS: 'MENU_DOCUMENTOS',
});

const FALLBACK_PHONE = config.fallback.phone;

// =============================================================================
// Configuração do Express
// =============================================================================

const app = express();

// -- Trust proxy (necessário para Cloudflare/nginx)
app.set('trust proxy', 1);

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
  const { chatId, text, contact, document, photo, caption, callbackData, callbackQueryId, messageId, firstName, lastName, username } = extracted;

  if (!chatId) {
    log.info('Payload sem chatId — ignorado.');
    return;
  }

  const session = getSession(chatId);

  // Captura dados do Telegram na sessão (para uso posterior no CRM)
  if (firstName || lastName || username) {
    updateSession(chatId, session.state, {
      telegramFirstName: firstName || session.telegramFirstName || null,
      telegramLastName: lastName || session.telegramLastName || null,
      telegramUsername: username || session.telegramUsername || null,
    });
  }

  // Verificar se recebeu documento ou foto
  if (document || photo) {
    await handleDocumentoRecebido(chatId, document, photo, caption, session, log);
    return;
  }

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

  // -- Comando /cancelar
  if (text === '/cancelar') {
    await handleCancel(chatId, firstName);
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
    case State.AWAITING_EMAIL:
      await handleAwaitingEmail(chatId, text, session, log);
      break;
    case State.AWAITING_PERICIA_CONFIRM:
    case State.AWAITING_PERICIA_SLOT:
      // Aguardando callback — ignorar texto
      await telegram.sendMessage(chatId, '👆 Por favor, utilize os botões acima para continuar.');
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

    case State.AWAITING_BOOKING_SLOT:
      // Usuário digitou em vez de usar os botões — pedir para usar botões
      await telegram.sendMessage(
        chatId,
        '👆 Por favor, selecione um dos horários oferecidos acima clicando nos botões.\n\n' +
          'Ou digite <b>/cancelar</b> para voltar ao menu principal.'
      );
      break;

    case State.AWAITING_DEAL_SELECTION:
      // Usuário digitou em vez de usar os botões — pedir para usar botões
      await telegram.sendMessage(
        chatId,
        '👆 Por favor, selecione um dos processos listados acima clicando nos botões.\n\n' +
          'Ou digite <b>/cancelar</b> para voltar ao menu principal.'
      );
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
  // Handle slot booking callbacks
  if (callbackData.startsWith('BOOK_SLOT_')) {
    const slotIndex = parseInt(callbackData.replace('BOOK_SLOT_', ''), 10);
    await handleSlotSelection(chatId, slotIndex, session, log);
    return;
  }

  // Handle deal selection callbacks (Status do Processo)
  if (callbackData.startsWith('STATUS_DEAL_')) {
    const dealId = callbackData.replace('STATUS_DEAL_', '');
    await handleDealSelection(chatId, dealId, session, log);
    return;
  }

  // Handle call request callbacks
  if (callbackData === 'CALL_CONFIRM') {
    await processCallRequest(chatId, session, session.phone, log);
    return;
  }
  if (callbackData === 'CALL_OTHER_NUMBER') {
    await telegram.requestContact(
      chatId,
      '📱 Por favor, compartilhe o número que deseja receber a ligação:'
    );
    updateSession(chatId, State.AWAITING_CALLBACK_DETAILS);
    return;
  }

  if (callbackData === 'BOOK_PHONE' || callbackData === 'BOOK_ONLINE') {
    await telegram.sendMessage(
      chatId,
      `🌐 Agende online:\n<a href="https://agenda.bitrix24.site/atendimento-online/">📆 Agenda Online</a>\n\nOu entre em contato: <b>${FALLBACK_PHONE}</b>`
    );
    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
    return;
  }

  switch (callbackData) {
    case CALLBACK.MENU_STATUS:
      await promptForStatusCpf(chatId, log);
      break;

    case CALLBACK.MENU_AGENDAMENTO:
      await handleAgendamento(chatId, session, log);
      break;

    case CALLBACK.MENU_CHAMADA:
      await promptForCallbackDetails(chatId, session);
      break;

    case CALLBACK.MENU_FALAR_EQUIPE:
      await handleHandoff(chatId, session, log);
      break;

    case CALLBACK.MENU_BOLETO:
      await handleBoletoLookup(chatId, session, log);
      break;

    case CALLBACK.MENU_PERICIA:
      await handlePericiaLookup(chatId, session, log);
      break;

    case CALLBACK.MENU_DOCUMENTOS:
      await handleEnviarDocumentos(chatId, session, log);
      break;

    case 'PERICIA_CONFIRM_YES':
      await handlePericiaBooking(chatId, session, log);
      break;

    case 'PERICIA_CONFIRM_NO':
      await telegram.sendMessage(
        chatId,
        '✅ Tudo bem! Se mudar de ideia, é só acessar o menu novamente.'
      );
      await showMainMenu(chatId, getSession(chatId));
      break;

    case CALLBACK.MENU_VOLTAR:
      await showMainMenu(chatId, getSession(chatId));
      break;

    default:
      // Verificar se é um slot de perícia
      if (callbackData && callbackData.startsWith('PERICIA_SLOT_')) {
        await handlePericiaSlotSelection(chatId, callbackData, session, log);
      } else {
        log.info(`Callback desconhecido: ${callbackData}`);
        await showMainMenu(chatId, session);
      }
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

  // Se estamos aguardando detalhes de chamada, processar a solicitação
  if (session.state === State.AWAITING_CALLBACK_DETAILS) {
    await processCallRequest(chatId, updated, cleanPhone, log);
    return;
  }

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
  log.info(`[CPF] Texto recebido: "${text}" | CPF extraído: ${cpfFromMessage} | Válido: ${cpfFromMessage ? hermesAI.isValidCpf(cpfFromMessage) : 'N/A'}`);

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

  // Autentica direto com CPF — telefone é opcional
  await authenticateClient(chatId, updated, log);
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

  // Após cadastro, pede e-mail para atualizar CRM
  updateSession(chatId, State.AWAITING_EMAIL, {
    telegramFirstName: session.telegramFirstName || null,
    telegramLastName: session.telegramLastName || null,
    telegramUsername: session.telegramUsername || null,
  });

  await telegram.sendMessage(
    chatId,
    'Por favor, informe seu <b>e-mail</b> para mantermos seu cadastro atualizado:'
  );
}

// ---------------------------------------------------------------------------
// FASE 1d-2: Aguardando E-mail (atualiza CRM com dados do Telegram)
// ---------------------------------------------------------------------------

async function handleAwaitingEmail(chatId, text, session, log) {
  const email = (text || '').trim().toLowerCase();
  
  // Validação básica de e-mail
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    await telegram.sendMessage(
      chatId,
      '❌ E-mail inválido. Por favor, informe um <b>e-mail válido</b> (ex: nome@email.com):'
    );
    return;
  }

  log.info(`[EMAIL] E-mail recebido: ${email} | Contato ID: ${session.crmContactId}`);

  // Atualiza contato no CRM
  if (session.crmContactId) {
    const fields = {
      EMAIL: [{ VALUE: email, VALUE_TYPE: 'WORK' }],
    };

    // Adiciona nome do Telegram se disponível
    if (session.telegramFirstName) {
      fields.NAME = session.telegramFirstName;
      if (session.telegramLastName) {
        fields.LAST_NAME = session.telegramLastName;
      }
    }

    // Campo IMOL (messenger) com username do Telegram
    if (session.telegramUsername) {
      fields.IMOL = `@${session.telegramUsername}`;
    } else {
      // Se não tem username, usa o ID do Telegram
      fields.IMOL = `Telegram ID: ${chatId}`;
    }

    const updated = await bitrix24.updateContact(session.crmContactId, fields);
    if (updated) {
      log.info(`[EMAIL] Contato ${session.crmContactId} atualizado com sucesso`);
    } else {
      log.warn(`[EMAIL] Falha ao atualizar contato ${session.crmContactId}`);
    }
  }

  // Atualiza sessão e mostra menu
  updateSession(chatId, State.AUTHENTICATED, { email });
  appendHistory(chatId, 'system', `E-mail atualizado: ${email}`);

  await telegram.sendMessage(
    chatId,
    `✅ E-mail <b>${email}</b> registrado com sucesso!\n` +
    `Seus dados estão atualizados em nosso sistema.`
  );

  await showMainMenu(chatId, getSession(chatId));
}

// ---------------------------------------------------------------------------
// FASE 1e: Autenticação contra o CRM
// ---------------------------------------------------------------------------

async function authenticateClient(chatId, session, log) {
  try {
    await telegram.sendMessage(chatId, '🔍 Consultando nosso sistema...');
    log.info(`[AUTH] Buscando contato com CPF: ${session.cpf} | Telefone: ${session.phone}`);

    const [contacts, leads] = await Promise.all([
      bitrix24.findContactByCpfOrPhone({ cpf: session.cpf, phone: session.phone }),
      bitrix24.findLeadByCpfOrPhone({ cpf: session.cpf, phone: session.phone }),
    ]);

    log.info(`[AUTH] Resultado: ${contacts?.length || 0} contatos, ${leads?.length || 0} leads`);
    if (contacts?.[0]) log.info(`[AUTH] Contato encontrado: ${contacts[0].NAME} ${contacts[0].LAST_NAME} (ID: ${contacts[0].ID})`);

    const foundContact = contacts?.[0];
    const foundLead = leads?.[0];

    if (foundContact) {
      const contactName =
        [foundContact.NAME, foundContact.LAST_NAME].filter(Boolean).join(' ') || 'Cliente';
      
      // Extrair telefone do contato no CRM
      let crmPhone = null;
      if (foundContact.PHONE && Array.isArray(foundContact.PHONE) && foundContact.PHONE.length > 0) {
        crmPhone = foundContact.PHONE[0].VALUE || null;
      }
      
      // Salva dados do contato na sessão e pede e-mail
      updateSession(chatId, State.AWAITING_EMAIL, {
        name: contactName,
        crmContactId: foundContact.ID,
        phone: crmPhone || session.phone || null,
        telegramFirstName: session.telegramFirstName || null,
        telegramLastName: session.telegramLastName || null,
        telegramUsername: session.telegramUsername || null,
      });

      const deals = await bitrix24.getDealsByContact(foundContact.ID);
      if (deals.length > 0) {
        updateSession(chatId, State.AWAITING_EMAIL, { crmDealId: deals[0].ID });
      }

      await telegram.sendMessage(
        chatId,
        `✅ <b>Identidade confirmada!</b>\nBem-vindo(a) de volta, ${contactName}.\n\n` +
        `Por favor, informe seu <b>e-mail</b> para mantermos seu cadastro atualizado:`
      );
      return; // Aguarda e-mail antes de mostrar menu
    } else if (foundLead) {
      const leadName = foundLead.NAME || foundLead.TITLE || 'Cliente';
      
      // Extrair telefone do lead no CRM
      let crmPhone = null;
      if (foundLead.PHONE && Array.isArray(foundLead.PHONE) && foundLead.PHONE.length > 0) {
        crmPhone = foundLead.PHONE[0].VALUE || null;
      }
      
      updateSession(chatId, State.AUTHENTICATED, {
        name: leadName,
        crmContactId: foundLead.ID,
        phone: crmPhone || session.phone || null,
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
        telegramFirstName: session.telegramFirstName || null,
        telegramLastName: session.telegramLastName || null,
        telegramUsername: session.telegramUsername || null,
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
// OPÇÃO: Enviar Certidão de Nascimento / Documentos
// =============================================================================

async function handleEnviarDocumentos(chatId, session, log) {
  const clientName = session.name || 'Cliente';

  await telegram.sendMessage(
    chatId,
    `📎 <b>Envio de Documentos</b>\n\n` +
    `<b>${clientName}</b>, para enviar sua certidão de nascimento ou outros documentos,\n` +
    `basta enviar o arquivo diretamente aqui nesta conversa.\n\n` +
    `⚠️ <b>ATENÇÃO:</b> As fotos devem ser tiradas corretamente para que o INSS aceite\n` +
    `e seu processo <b>não entre em exigência</b>.\n\n` +
    `🎥 <b>Assista este tutorial antes de enviar:</b>\n` +
    `<a href="https://vimeo.com/1177468232?share=copy&fl=sv&fe=ci">▶️ Como tirar fotos dos documentos</a>\n\n` +
    `📄 <b>Formatos aceitos:</b>\n` +
    `• PDF, JPG, PNG, DOC, DOCX\n\n` +
    `📋 <b>Documentos comuns:</b>\n` +
    `• Certidão de Nascimento\n` +
    `• RG / CNH\n` +
    `• CPF\n` +
    `• Comprovante de residência\n` +
    `• Laudos e exames médicos\n\n` +
    `✅ Envie <b>um documento por vez</b> para garantir o recebimento correto.`
  );

  updateSession(chatId, State.AUTHENTICATED);
}

async function handleDocumentoRecebido(chatId, document, photo, caption, session, log) {
  const clientName = session.name || 'Cliente';
  const cpf = session.cpf || 'Não informado';
  const contactId = session.crmContactId || 'N/A';

  log.info(`[DOC] Documento recebido de ${clientName} (CPF: ${cpf}, ContactID: ${contactId})`);

  // Obter link do documento/foto no Telegram
  let docLink = '';
  try {
    const fileId = photo ? photo[photo.length - 1].file_id : document.file_id;
    const fileInfo = await telegram.getFile(fileId);
    docLink = telegram.getFileUrl(fileInfo.file_path);
  } catch (err) {
    log.error(`[DOC] Erro ao obter link do documento: ${err.message}`);
  }

  // Montar link do contato no Bitrix24
  const bitrixContactUrl = `https://brandaocorrea.bitrix24.com.br/crm/contact/details/${contactId}/`;

  // Montar mensagem URGENTE para operadores
  const urgentMessage = 
    `🚨 <b>DOCUMENTO RECEBIDO URGENTE</b> 🚨\n\n` +
    `👤 <b>Cliente:</b> ${clientName}\n` +
    `📋 <b>CPF:</b> ${cpf}\n` +
    `🔗 <b>Cadastro Bitrix24:</b> <a href="${bitrixContactUrl}">Abrir contato</a>\n` +
    `${docLink ? `📎 <b>Link do documento:</b> <a href="${docLink}">Abrir arquivo</a>\n` : ''}` +
    `${caption ? `\n💬 <b>Observação do cliente:</b> ${caption}` : ''}`;

  // Enviar mensagem URGENTE via Bitrix24 IM (chat geral + Rodrigo + Larissa)
  const bitrixDestinations = ['chat1', '1', '76239'];
  for (const dialogId of bitrixDestinations) {
    try {
      await bitrix24.sendBitrix24Message(dialogId, 
        `[B]🚨 DOCUMENTO RECEBIDO URGENTE 🚨[/B]\n\n` +
        `[B]Cliente:[/B] ${clientName}\n` +
        `[B]CPF:[/B] ${cpf}\n` +
        `[B]Cadastro Bitrix24:[/B] ${bitrixContactUrl}\n` +
        `${docLink ? `[B]Link do documento:[/B] ${docLink}\n` : ''}` +
        `${caption ? `\n[B]Observação do cliente:[/B] ${caption}` : ''}`
      );
      log.info(`[DOC] Alerta enviado via Bitrix24 IM para ${dialogId}`);
    } catch (err) {
      log.error(`[DOC] Erro ao enviar alerta para ${dialogId}: ${err.message}`);
    }
  }

  // Confirmar recebimento ao cliente
  await telegram.sendMessage(
    chatId,
    `✅ <b>Documento recebido com sucesso!</b>\n\n` +
    `Recebemos seu documento e nossa equipe foi notificada.\n` +
    `Você receberá um retorno em breve.\n\n` +
    `📌 Se precisar enviar mais documentos, envie um por vez.`
  );

  await showMainMenu(chatId, getSession(chatId));
}

// =============================================================================
// OPÇÃO: Consultar Data da Perícia Médica
// =============================================================================

async function handlePericiaBooking(chatId, session, log) {
  await telegram.sendMessage(chatId, '📅 Buscando horários disponíveis para orientação...');

  try {
    // Buscar bookings existentes para evitar conflitos
    const existingBookings = await bitrix24.getExistingBookings();
    const slots = bitrix24.generatePericiaSlots(existingBookings);

    if (!slots || slots.length === 0) {
      await telegram.sendMessage(
        chatId,
        '😔 Infelizmente não há horários disponíveis no momento.\n\n' +
        'Por favor, entre em contato pelo telefone para agendar manualmente:\n' +
        '☎️ <b>(65) 3052-5278</b>'
      );
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    // Salvar slots na sessão
    updateSession(chatId, State.AWAITING_PERICIA_SLOT, { _periciaSlots: slots });

    // Montar botões com as 3 opções
    const buttons = slots.map((slot, index) => [{
      text: `📅 ${slot.label}`,
      callback_data: `PERICIA_SLOT_${index}`,
    }]);

    await telegram.sendInlineKeyboard(
      chatId,
      '📋 <b>Horários disponíveis para Orientação Pericial:</b>\n\n' +
      'Escolha o melhor dia e horário para você:',
      buttons
    );

  } catch (err) {
    log.error(`[PERICIA] Erro ao buscar slots: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      '⚠️ Não foi possível buscar horários no momento.\n\n' +
      'Por favor, agende pelo link abaixo ou entre em contato pelo telefone:\n' +
      '🔗 <a href="https://documentosbrandaocorrea.bitrix24.site/agendamento/">Agendar Online</a>\n' +
      '☎️ <b>(65) 3052-5278</b>'
    );
    await showMainMenu(chatId, getSession(chatId));
  }
}

async function handlePericiaSlotSelection(chatId, callbackData, session, log) {
  const slotIndex = parseInt(callbackData.replace('PERICIA_SLOT_', ''));
  const slots = session._periciaSlots;

  if (!slots || isNaN(slotIndex) || slotIndex < 0 || slotIndex >= slots.length) {
    await telegram.sendMessage(chatId, '❌ Opção inválida. Por favor, tente novamente.');
    await showMainMenu(chatId, getSession(chatId));
    return;
  }

  const selectedSlot = slots[slotIndex];
  const dealId = session._periciaDealId;
  const contactId = session.crmContactId;

  await telegram.sendMessage(
    chatId,
    `📅 Agendando orientação para <b>${selectedSlot.label}</b>...`
  );

  try {
    const clientName = session.name || 'Cliente';
    const bookingName = `${clientName} - Orientação Perícia`;

    const bookingResult = await bitrix24.createBooking({
      name: bookingName,
      resourceId: selectedSlot.resourceId,
      fromTs: selectedSlot.fromTs,
      toTs: selectedSlot.toTs,
      description: `Orientação pré-perícia agendada via bot`,
      contactId: contactId,
      dealId: dealId,
    });

    if (bookingResult) {
      await telegram.sendMessage(
        chatId,
        `✅ <b>Agendamento confirmado!</b>\n\n` +
        `📅 <b>Data:</b> ${selectedSlot.label}\n` +
        `📍 <b>Modalidade:</b> Online ou Presencial\n\n` +
        `🔗 O link da reunião será enviado <b>10 minutos antes</b> do horário agendado.\n\n` +
        `📌 <b>Orientações importantes:</b>\n` +
        `• Tenha em mãos todos os seus documentos médicos\n` +
        `• Prepare suas dúvidas sobre a perícia\n` +
        `• O advogado irá orientá-lo sobre o que fazer e falar\n\n` +
        `🤩 Compareça no horário agendado. Boa sorte!`
      );
    } else {
      throw new Error('Falha ao criar booking');
    }
  } catch (err) {
    log.error(`[PERICIA] Erro ao criar booking: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      '⚠️ Não foi possível confirmar o agendamento automaticamente.\n\n' +
      'Por favor, agende pelo link abaixo ou entre em contato pelo telefone:\n' +
      '🔗 <a href="https://documentosbrandaocorrea.bitrix24.site/agendamento/">Agendar Online</a>\n' +
      '☎️ <b>(65) 3052-5278</b>'
    );
  }

  // Limpar dados temporários e voltar ao menu
  updateSession(chatId, State.AUTHENTICATED, {
    _periciaSlots: null,
    _periciaDealId: null,
    _periciaDetails: null,
  });
  await showMainMenu(chatId, getSession(chatId));
}

// =============================================================================
// OPÇÃO: Consultar Data da Perícia Médica
// =============================================================================

async function handlePericiaLookup(chatId, session, log) {
  const contactId = session.crmContactId;

  if (!contactId) {
    await telegram.sendMessage(
      chatId,
      '❌ Não foi possível identificar seu cadastro. Por favor, informe seu <b>CPF</b> novamente.'
    );
    return;
  }

  await telegram.sendMessage(chatId, '🔍 Buscando informações sobre sua perícia médica...');

  try {
    const deals = await bitrix24.getDealsByContact(contactId);

    if (!deals || deals.length === 0) {
      await telegram.sendMessage(
        chatId,
        '📋 Não encontramos processos vinculados ao seu cadastro no momento.\n\n' +
        'Se você acredita que isso é um erro, entre em contato pelo telefone: <b>' + FALLBACK_PHONE + '</b>.'
      );
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    // Buscar detalhes completos — encontrar PRIMEIRA perícia agendada
    let periciaDeal = null;
    let periciaDetails = null;

    for (const deal of deals) {
      const dealDetails = await bitrix24.getDealDetails(deal.ID);
      if (!dealDetails) continue;

      const dataPericia = dealDetails.UF_CRM_1747855086;
      if (dataPericia) {
        periciaDeal = deal;
        periciaDetails = dealDetails;
        break; // Apenas a primeira perícia
      }
    }

    if (!periciaDetails) {
      await telegram.sendMessage(
        chatId,
        '📋 Não encontramos nenhuma perícia médica agendada nos seus processos no momento.\n\n' +
        'Caso tenha dúvidas, entre em contato pelo telefone: <b>' + FALLBACK_PHONE + '</b>.'
      );
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    // Enviar bloco de informações da perícia
    const clientName = session.name || 'Cliente';
    const periciaBlock = bitrix24.formatPericiaBlock(periciaDetails, clientName);
    await telegram.sendMessage(chatId, periciaBlock);

    // Salvar dados da perícia na sessão para uso posterior
    updateSession(chatId, State.AWAITING_PERICIA_CONFIRM, {
      _periciaDealId: periciaDeal.ID,
      _periciaDetails: periciaDetails,
    });

    // Perguntar se quer agendar orientação
    await telegram.sendInlineKeyboard(
      chatId,
      `💼 <b>${clientName}</b>, agora precisamos agendar a <b>orientação</b> que você deve fazer antes de realizar a perícia.\n\n` +
      `Deseja agendar agora?`,
      [
        [{ text: '✅  SIM, QUERO AGENDAR  ✅', callback_data: 'PERICIA_CONFIRM_YES' }],
        [{ text: 'Não', callback_data: 'PERICIA_CONFIRM_NO' }],
      ]
    );

  } catch (err) {
    log.error(`[PERICIA] Erro ao buscar perícia: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      '⚠️ Ocorreu um erro ao consultar suas informações. Por favor, tente novamente mais tarde.'
    );
    await showMainMenu(chatId, getSession(chatId));
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
      await promptForStatusCpf(chatId, log);
      break;

    case hermesAI.Intent.AGENDAMENTO:
      await handleAgendamento(chatId, session);
      break;

    case hermesAI.Intent.SOLICITAR_CHAMADA:
      await promptForCallbackDetails(chatId, session);
      break;

    case hermesAI.Intent.BOLETO:
      await handleBoletoLookup(chatId, session, log);
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
    [{ text: '💳 2ª Via de Boleto', callback_data: CALLBACK.MENU_BOLETO }],
    [{ text: '👩‍💼 Falar com a Equipe', callback_data: CALLBACK.MENU_FALAR_EQUIPE }],
    [{ text: '🩺 Consultar Data da Perícia', callback_data: CALLBACK.MENU_PERICIA }],
    [{ text: '📎 Enviar Documentos', callback_data: CALLBACK.MENU_DOCUMENTOS }],
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

async function promptForStatusCpf(chatId, log) {
  const session = getSession(chatId);

  // Se já tem CPF na sessão, busca direto sem pedir novamente
  if (session.cpf) {
    await handleStatusLookup(chatId, session.cpf, log);
    return;
  }

  updateSession(chatId, State.AWAITING_STATUS_CPF);

  await telegram.sendMessage(
    chatId,
    '📋 <b>Consulta de Processo</b>\n\n' +
      'Por favor, informe o <b>CPF</b> associado ao processo que deseja consultar:'
  );
}

async function handleStatusLookup(chatId, text, log) {
  // Se o texto é um deal ID (callback interno), buscar direto
  if (/^\d+$/.test(text) && text.length < 10) {
    // Pode ser CPF ou deal ID — tentar como CPF primeiro
  }

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
          'Verifique se o número está correto ou entre em contato pelo telefone fixo: ' +
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
      updateSession(chatId, State.AUTHENTICATED);
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    // Se tem apenas 1 negócio, mostrar detalhes direto
    if (deals.length === 1) {
      const deal = deals[0];
      const details = bitrix24.formatDealDetails(deal, session.name || 'Cliente');
      await telegram.sendMessage(
        chatId,
        `📋 <b>Status do Processo</b>\n\n${details}`
      );
      updateSession(chatId, State.AUTHENTICATED);
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    // Se tem mais de 1 negócio, mostrar lista para seleção
    const summaryList = deals
      .slice(0, 5)
      .map((deal, i) => bitrix24.formatDealSummary(deal, i))
      .join('\n\n');

    const moreText = deals.length > 5
      ? `\n\n<i>Mostrando 5 de ${deals.length} processos.</i>`
      : '';

    // Salvar deals na sessão para usar no callback
    updateSession(chatId, State.AWAITING_DEAL_SELECTION, {
      _dealsList: deals.slice(0, 5),
    });

    // Botões para cada negócio
    const buttons = deals.slice(0, 5).map((deal, i) => {
      const servicoRaw = deal.UF_CRM_1731420853730 || deal.TITLE || `#${deal.ID}`;
      // Se for ID numérico, usar o título do deal como fallback no botão
      const servico = /^\d+$/.test(String(servicoRaw)) ? (deal.TITLE || `Processo #${deal.ID}`) : servicoRaw;
      const { emoji } = bitrix24.getStageStatus(deal);
      return [{
        text: `${emoji} ${servico.length > 40 ? servico.substring(0, 40) + '...' : servico}`,
        callback_data: `STATUS_DEAL_${deal.ID}`,
      }];
    });

    await telegram.sendInlineKeyboard(
      chatId,
      `📋 <b>Seus Processos</b> — Selecione para ver detalhes:\n\n${summaryList}${moreText}`,
      buttons
    );

  } catch (err) {
    log.error(`Erro ao consultar processos: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ No momento nosso sistema de consultas está em manutenção. ` +
        `Por favor, entre em contato pelo telefone fixo: <b>${FALLBACK_PHONE}</b>.`
    );
    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  }
}

// ---------------------------------------------------------------------------
// Handler: Seleção de negócio (Status do Processo)
// ---------------------------------------------------------------------------

async function handleDealSelection(chatId, dealId, session, log) {
  try {
    await telegram.sendMessage(chatId, '🔍 Buscando detalhes do processo...');

    // Buscar detalhes completos do deal
    const deal = await bitrix24.getDealDetails(dealId);

    if (!deal || !deal.ID) {
      await telegram.sendMessage(chatId, '❌ Processo não encontrado. Tente novamente.');
      updateSession(chatId, State.AUTHENTICATED);
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    const details = bitrix24.formatDealDetails(deal, session.name || 'Cliente');

    await telegram.sendMessage(
      chatId,
      `📋 <b>Status do Processo</b>\n\n${details}`
    );

    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));

  } catch (err) {
    log.error(`[Status] Erro ao buscar deal ${dealId}: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ Erro ao consultar processo. Por favor, entre em contato pelo telefone fixo: <b>${FALLBACK_PHONE}</b>.`
    );
    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  }
}

// =============================================================================
// OPÇÃO 2: Agendamento de Horário
// =============================================================================

async function handleAgendamento(chatId, session, log) {
  try {
    await telegram.sendMessage(chatId, '📅 <b>Agendamento de Horário</b>\n\nVerificando horários disponíveis...');

    // 1. Garantir que o cliente tem um deal ativo
    let dealId = session.crmDealId;
    console.log(`[AGENDAMENTO] dealId inicial: ${dealId}, contactId: ${session.crmContactId}`);
    
    if (!dealId && session.crmContactId) {
      // Buscar deals existentes do contato
      const deals = await bitrix24.getDealsByContact(session.crmContactId);
      const activeDeal = deals.find(d => !d.STAGE_ID?.includes('WON') && !d.STAGE_ID?.includes('LOSE'));
      
      if (activeDeal) {
        dealId = activeDeal.ID;
        updateSession(chatId, session.state, { crmDealId: dealId });
      } else {
        // Criar novo deal para agendamento
        log.info(`[Agendamento] Criando novo deal para contato ${session.crmContactId}`);
        dealId = await bitrix24.createDeal({
          title: `Agendamento - ${session.name || 'Cliente'} - ${new Date().toLocaleDateString('pt-BR')}`,
          contactId: session.crmContactId,
          categoryId: 0, // Funil padrão
        });
        updateSession(chatId, session.state, { crmDealId: dealId });
        log.info(`[Agendamento] Deal criado: ${dealId}`);
      }
    }

    // 2. Buscar bookings existentes nas salas de vídeo
    const today = new Date();
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 7);
    
    const fromDate = today.toISOString().split('T')[0];
    const toDate = endDate.toISOString().split('T')[0];
    
    const existingBookings = await bitrix24.getExistingBookings(fromDate, toDate);
    log.info(`[Agendamento] ${existingBookings.length} bookings existentes nas salas`);

    // 3. Gerar slots disponíveis (3 opções no próximo dia útil)
    const availableSlots = bitrix24.generateAvailableSlots(existingBookings);
    
    if (availableSlots.length === 0) {
      await telegram.sendMessage(
        chatId,
        '😔 <b>Nenhum horário disponível no próximo dia útil.</b>\n\n' +
          'Você pode agendar online:\n' +
          `<a href="https://agenda.bitrix24.site/atendimento-online/">📆 Agenda Online</a>\n\n` +
          `Ou entre em contato: <b>${FALLBACK_PHONE}</b>`
      );
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    // 4. Salvar slots na sessão para usar no callback
    updateSession(chatId, State.AWAITING_BOOKING_SLOT, {
      _availableSlots: availableSlots,
      _bookingDealId: dealId,
    });

    // 5. Mostrar opções com botões inline
    const buttons = availableSlots.map((slot, i) => [{
      text: `📅 ${slot.label}`,
      callback_data: `BOOK_SLOT_${i}`,
    }]);
    
    // Adicionar botão "Agendar online"
    buttons.push([{
      text: '🌐 Agendar online',
      callback_data: 'BOOK_ONLINE',
    }]);

    const nextDay = availableSlots[0]?.label?.split(' às ')[0] || 'próximo dia útil';

    await telegram.sendInlineKeyboard(
      chatId,
      `📋 <b>Horários disponíveis para ${nextDay}:</b>\n\nEscolha uma opção abaixo:`,
      buttons
    );

  } catch (err) {
    log.error(`[Agendamento] Erro: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ No momento o sistema de agendamento está em manutenção.\n\n` +
        `Você pode agendar online:\n` +
        `<a href="https://agenda.bitrix24.site/atendimento-online/">📆 Agenda Online</a>\n\n` +
        `Ou entre em contato: <b>${FALLBACK_PHONE}</b>`
    );
    await showMainMenu(chatId, getSession(chatId));
  }
}

// ---------------------------------------------------------------------------
// Handler: Seleção de slot de agendamento
// ---------------------------------------------------------------------------

async function handleSlotSelection(chatId, slotIndex, session, log) {
  try {
    const slots = session._availableSlots || [];
    const selectedSlot = slots[slotIndex];

    if (!selectedSlot) {
      await telegram.sendMessage(chatId, '❌ Horário inválido. Por favor, tente novamente.');
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    console.log(`[BOOKING] Slot selecionado: índice=${slotIndex}`, JSON.stringify(selectedSlot));
    await telegram.sendMessage(chatId, '✅ <b>Confirmando agendamento...</b>');

    // 1. Tentar criar booking — se falhar, tentar próximo slot
    const dealId = session._bookingDealId;
    const contactId = session.crmContactId;

    let bookingId = null;
    let usedSlot = selectedSlot;

    // Tentar o slot selecionado primeiro, depois os outros
    const slotsToTry = [selectedSlot, ...slots.filter((_, i) => i !== slotIndex)];

    for (const slot of slotsToTry) {
      try {
        // Descrição detalhada para o booking e timeline
        const description = [
          `Agendamento via bot Telegram`,
          `Cliente: ${session.name || 'Não identificado'}`,
          `CPF: ${session.cpf || 'Não informado'}`,
          `Sala: ${slot.roomName}`,
          dealId ? `Deal ID: #${dealId}` : '',
          contactId ? `Contact ID: #${contactId}` : '',
        ].filter(Boolean).join('\n');

        bookingId = await bitrix24.createBooking({
          name: `${session.name || 'Cliente'} - ${slot.roomName}`,
          resourceId: slot.resourceId,
          fromTs: slot.fromTs,
          toTs: slot.toTs,
          description,
          contactId: contactId || undefined,
          dealId: dealId || undefined,
        });
        usedSlot = slot;
        break; // Sucesso!
      } catch (bookingErr) {
        console.log(`[BOOKING] Slot ${slot.label} falhou: ${bookingErr.message} — tentando próximo...`);
        continue;
      }
    }

    if (!bookingId) {
      // Todos os slots falharam — oferecer link manual
      await telegram.sendMessage(
        chatId,
        `⚠️ Não foi possível agendar automaticamente. Os horários podem estar ocupados.\n\n` +
          `Você pode agendar manualmente:\n` +
          `<a href="https://documentosbrandaocorrea.bitrix24.site/agendamento/">📆 Agendar Online</a>\n\n` +
          `Ou entre em contato: <b>${FALLBACK_PHONE}</b>`
      );
      updateSession(chatId, State.AUTHENTICATED);
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    log.info(`[Agendamento] Booking criado: ${bookingId} | Slot: ${usedSlot.label} | Deal: ${dealId} | Contact: ${session.crmContactId}`);
    console.log(`[BOOKING] Confirmado: bookingId=${bookingId}, dealId=${dealId}, contactId=${session.crmContactId}`);

    // 2. Atualizar sessão
    updateSession(chatId, State.AUTHENTICATED, {
      _availableSlots: null,
      _bookingDealId: null,
    });

    // 3. Confirmar para o cliente
    const dealInfo = dealId ? `📋 <b>Processo vinculado:</b> #${dealId}\n` : '';
    await telegram.sendMessage(
      chatId,
      `✅ <b>Agendamento confirmado!</b>\n\n` +
        `📅 <b>${usedSlot.label}</b>\n` +
        `📍 Sala: ${usedSlot.roomName}\n\n` +
        dealInfo +
        `\nVocê receberá uma confirmação. Se precisar reagendar, entre em contato.` +
        `\n\n📞 <b>${FALLBACK_PHONE}</b>`
    );

    await showMainMenu(chatId, getSession(chatId));

  } catch (err) {
    log.error(`[Agendamento] Erro ao confirmar slot: ${err.message}`);
    console.error(`[BOOKING] Erro geral: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ Erro ao confirmar agendamento. Você pode agendar online:\n` +
        `<a href="https://documentosbrandaocorrea.bitrix24.site/agendamento/">📆 Agenda Online</a>\n\n` +
        `Ou entre em contato: <b>${FALLBACK_PHONE}</b>`
    );
    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  }
}

// =============================================================================
// OPÇÃO 3: Solicitar uma Chamada
// =============================================================================

async function promptForCallbackDetails(chatId, session) {
  // Verificar se já tem telefone no cadastro
  const phone = session.phone;

  if (phone) {
    // Já tem telefone — perguntar se quer usar esse ou outro
    await telegram.sendInlineKeyboard(
      chatId,
      '📞 <b>Solicitação de Chamada</b>\n\n' +
        `Encontramos o número <b>${phone}</b> no seu cadastro.\n\n` +
        'Deseja receber a ligação neste número?',
      [
        [{ text: `✅ Sim, ligar no ${phone}`, callback_data: 'CALL_CONFIRM' }],
        [{ text: '📱 Usar outro número', callback_data: 'CALL_OTHER_NUMBER' }],
        [{ text: '📅 Agendar Online (MeLigue)', url: 'https://agenda.bitrix24.site/meligue/' }],
      ]
    );
  } else {
    // Não tem telefone — pedir para informar
    await telegram.sendMessage(
      chatId,
      '📞 <b>Solicitação de Chamada</b>\n\n' +
        'Para prosseguir, por favor informe o número de telefone onde deseja receber a ligação:\n\n' +
        '💡 <i>Envie o número no formato: (XX) XXXXX-XXXX</i>\n\n' +
        '🔗 <b>Ou agende uma ligação online:</b>\n' +
        '<a href="https://agenda.bitrix24.site/meligue/">📅 Agendar Ligação (MeLigue)</a>'
    );
    updateSession(chatId, State.AWAITING_CALLBACK_DETAILS);
  }
}

async function handleCallbackDetails(chatId, text, log) {
  // Extrair telefone do texto ou do contato compartilhado
  const session = getSession(chatId);
  let phone = session.phone;

  // Se o texto parece um telefone, usar ele
  const phoneMatch = text?.match(/(\d{2}\s?\d{4,5}-?\d{4})/);
  if (phoneMatch) {
    phone = phoneMatch[1];
  }

  if (!phone) {
    await telegram.sendMessage(chatId, '❌ Não consegui identificar o número. Tente novamente.');
    return;
  }

  await processCallRequest(chatId, session, phone, log);
}

/**
 * Processa a solicitação de chamada: registra no CRM e notifica a equipe.
 */
async function processCallRequest(chatId, session, phone, log) {
  try {
    const clientName = session.name || 'Cliente não identificado';
    const contactId = session.crmContactId || 'N/A';
    const telegramUser = session.telegramUsername ? `@${session.telegramUsername}` : `ID: ${chatId}`;
    const bitrixContactUrl = `https://brandaocorrea.bitrix24.com.br/crm/contact/details/${contactId}/`;

    // Atualizar telefone na sessão
    updateSession(chatId, session.state, { phone });

    // 1. Registrar no timeline do contato/deal
    try {
      await bitrix24.createCallActivity({
        ownerId: config.bitrix24.operatorAliceId,
        contactId: session.crmContactId || undefined,
        dealId: session.crmDealId || undefined,
        phone,
      });
    } catch (crmErr) {
      log.warn(`[Chamada] Falha ao registrar no CRM: ${crmErr.message}`);
    }

    // 2. Enviar mensagem URGENTE via Bitrix24 IM (chat geral + Rodrigo + Larissa)
    const bitrixDestinations = ['chat1', '1', '76239'];
    for (const dialogId of bitrixDestinations) {
      try {
        await bitrix24.sendBitrix24Message(dialogId, 
          `[B]🚨📞 SOLICITAÇÃO DE LIGAÇÃO URGENTE! 📞🚨[/B]\n\n` +
          `[B]Cliente:[/B] ${clientName}\n` +
          `[B]Telegram:[/B] ${telegramUser}\n` +
          `[B]Telefone:[/B] ${phone}\n` +
          `[B]Cadastro Bitrix24:[/B] ${bitrixContactUrl}\n\n` +
          `[B]⚠️ O cliente solicitou uma ligação telefônica![/B]\n` +
          `[B]Prioridade: ALTA[/B]`
        );
        log.info(`[Chamada] Alerta enviado via Bitrix24 IM para ${dialogId}`);
      } catch (err) {
        log.error(`[Chamada] Erro ao notificar ${dialogId}: ${err.message}`);
      }
    }

    // 3. Postar no workgroup 12
    try {
      const postTitle = `📞 Solicitação de Chamada - ${clientName}`;
      const postMessage = `[B]📞 Solicitação de Ligação[/B]\n\n` +
        `[B]Cliente:[/B] ${clientName}\n` +
        `[B]Telegram:[/B] ${telegramUser}\n` +
        `[B]Telefone:[/B] ${phone}\n` +
        `[B]Contato:[/B] ${contactId}`;
      await bitrix24.postToWorkgroup(12, postTitle, postMessage);
      log.info('[Chamada] Post criado no workgroup 12');
    } catch (err) {
      log.error(`[Chamada] Erro ao postar no workgroup: ${err.message}`);
    }

    // 4. Confirmar ao cliente
    await telegram.sendMessage(
      chatId,
      `✅ <b>Solicitação registrada!</b>\n\n` +
        `📞 Telefone: <b>${phone}</b>\n\n` +
        `Nossa equipe foi notificada e entrará em contato em breve.\n\n` +
        `📌 Você também pode agendar uma ligação online:\n` +
        `<a href="https://agenda.bitrix24.site/meligue/">📅 Agendar Ligação (MeLigue)</a>\n\n` +
        `<i>Aguarde nosso contato. Prioridade ALTA! ⚡</i>`
    );

  } catch (err) {
    log.error(`[Chamada] Erro: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ Houve um problema. Por favor, entre em contato pelo telefone fixo: <b>${FALLBACK_PHONE}</b>`
    );
  }

  updateSession(chatId, State.AUTHENTICATED);
  await showMainMenu(chatId, getSession(chatId));
}

// =============================================================================
// OPÇÃO 4: 2ª Via de Boleto Bancário (SPA 1130)
// =============================================================================

async function handleBoletoLookup(chatId, session, log) {
  try {
    await telegram.sendMessage(chatId, '💳 <b>2ª Via de Boleto Bancário</b>\n\nConsultando suas faturas...');

    const contactId = session.crmContactId;
    if (!contactId) {
      await telegram.sendMessage(
        chatId,
        '❌ Não foi possível identificar seu cadastro para consultar faturas.\n\n' +
          'Por favor, entre em contato pelo telefone fixo: <b>(65) 3052-5278</b>'
      );
      updateSession(chatId, State.AUTHENTICATED);
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    const faturas = await bitrix24.getFaturasByContact(contactId);
    log.info(`[Boleto] ${faturas.length} faturas encontradas para contato ${contactId}`);

    if (!faturas || faturas.length === 0) {
      await telegram.sendMessage(
        chatId,
        'ℹ️ Não encontramos faturas vinculadas ao seu cadastro no momento.\n\n' +
          'Se acredita que isso é um erro, entre em contato pelo telefone fixo: <b>(65) 3052-5278</b>'
      );
      updateSession(chatId, State.AUTHENTICATED);
      await showMainMenu(chatId, getSession(chatId));
      return;
    }

    // Limitar a 5 faturas para não exceder limite do Telegram
    const faturasExibir = faturas.slice(0, 5);
    const hasMore = faturas.length > 5;

    // Cabeçalho
    const header = `💳 <b>Suas Faturas</b> (${faturas.length} encontrada${faturas.length > 1 ? 's' : ''})\n` +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    // Montar corpo com todas as faturas
    const body = faturasExibir
      .map((fatura, i) => `<b>${i + 1}.</b>\n${bitrix24.formatFatura(fatura)}`)
      .join('\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

    const footer = hasMore
      ? `\n<i>Mostrando 5 de ${faturas.length} faturas. Entre em contato para ver todas.</i>`
      : '';

    await telegram.sendMessage(chatId, header + body + footer);

    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));

  } catch (err) {
    log.error(`[Boleto] Erro ao consultar faturas: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ No momento o sistema de consulta de faturas está em manutenção.\n\n` +
        `Por favor, entre em contato pelo telefone fixo: <b>(65) 3052-5278</b>`
    );
    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  }
}

// =============================================================================
// OPÇÃO 5: Falar com a Equipe (Transbordo / Handoff)
// =============================================================================

/**
 * Executa o protocolo de transbordo — notifica equipe via Bitrix24 IM.
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

    // Montar mensagem de notificação para a equipe
    const clientName = session.name || 'Cliente não identificado';
    const contactLink = session.crmContactId
      ? `https://brandaocorrea.bitrix24.com.br/crm/contact/details/${session.crmContactId}/`
      : 'Não disponível';

    const notificationMsg = [
      '[B]👩‍💼 SOLICITAÇÃO DE ATENDIMENTO HUMANO[/B]',
      '',
      `[B]Cliente:[/B] ${clientName}`,
      `[B]CPF:[/B] ${session.cpf || 'Não informado'}`,
      `[B]Telefone:[/B] ${session.phone || 'Não informado'}`,
      `[B]Contato CRM:[/B] ${contactLink}`,
      '',
      '[B]📋 Resumo da conversa:[/B]',
      summary,
      '',
      '[B]⚠️ Ação necessária:[/B] Responder o cliente pelo Telegram',
      '',
      `[I]Solicitação via bot Hermes. ${new Date().toLocaleString('pt-BR')}[/I]`,
    ].join('\n');

    // Enviar para chat geral, Rodrigo e Larissa (1x cada)
    const destinations = ['chat1', '1', '76239'];
    for (const dialogId of destinations) {
      try {
        await bitrix24.sendBitrix24Message(dialogId, notificationMsg);
      } catch (notifyErr) {
        log.warn(`[Handoff] Falha ao notificar ${dialogId}: ${notifyErr.message}`);
      }
    }

    log.info(`[Handoff] Notificação enviada para equipe Bitrix24`);

    await telegram.sendMessage(
      chatId,
      '✅ <b>Você está na fila de atendimento humano.</b>\n\n' +
        'Nossa equipe já foi notificada e entrará em contato em breve. ' +
        'Se preferir, também pode nos ligar: ' +
        `<b>${FALLBACK_PHONE}</b>.\n\n` +
        '<i>Obrigado pela paciência!</i>'
    );

    appendHistory(chatId, 'system', 'Handoff para equipe concluído.');
  } catch (err) {
    log.error(`Erro no transbordo: ${err.message}`);
    await telegram.sendMessage(
      chatId,
      `⚠️ Encontramos uma dificuldade ao transferir seu atendimento. ` +
        `Por favor, entre em contato diretamente pelo telefone fixo: <b>${FALLBACK_PHONE}</b>.`
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
// HANDLER: /cancelar
// =============================================================================

async function handleCancel(chatId, firstName) {
  const nome = firstName || 'Cliente';
  
  // Limpar sessão completamente
  deleteSession(chatId);
  
  await telegram.sendMessage(
    chatId,
    `👋 Até logo, ${nome}!\n\n` +
    `Obrigado por entrar em contato com o escritório <b>Brandão Corrêa</b>.\n\n` +
    `Caso precise de algo novamente, é só enviar <b>/start</b> para ` +
    `iniciar um novo atendimento.\n\n` +
    `Desejamos um ótimo dia! 😊\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Brandão Corrêa Assessoria Jurídica</b>\n` +
    `📞 (65) 3052-5278\n` +
    `🌐 brandaocorrea.com.br`
  );
}

// =============================================================================
// HANDLER: /start
// =============================================================================

async function handleStart(chatId, firstName) {
  // Limpar sessão completamente antes de recomeçar
  deleteSession(chatId);
  
  // Aguardar um instante para garantir que sessão foi limpa
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Criar nova sessão limpa e iniciar atendimento
  getSession(chatId);
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
