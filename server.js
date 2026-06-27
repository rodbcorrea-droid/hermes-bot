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
} from './middleware/session.js';

// =============================================================================
// Constantes
// =============================================================================

// Callback data dos botões do menu principal
const CALLBACK = Object.freeze({
  MENU_STATUS: 'MENU_STATUS',
  MENU_AGENDAMENTO: 'MENU_AGENDAMENTO',
  MENU_CHAMADA: 'MENU_CHAMADA',
  MENU_FALAR_EQUIPE: 'MENU_FALAR_EQUIPE',
  MENU_VOLTAR: 'MENU_VOLTAR',
  CONFIRM_CPF: 'CONFIRM_CPF',
});

// Telefone de contingência (fallback)
const FALLBACK_PHONE = config.fallback.phone;

// =============================================================================
// Configuração do Express
// =============================================================================

const app = express();

// -- Segurança básica
app.use(helmet());

// -- Rate limiting: protege o webhook contra abusos
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 60, // máximo 60 requisições por minuto por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde um momento.' },
});

// -- Parsing do corpo da requisição (JSON)
// O Telegram envia updates como JSON. Precisamos do corpo bruto para
// algumas verificações, mas o express.json já resolve.
app.use(express.json());

// =============================================================================
// Middleware de logging básico
// =============================================================================

app.use((req, _res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
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

app.post('/webhook/telegram', webhookLimiter, async (req, res) => {
  // Responde imediatamente com 200 OK para o Telegram não reenviar
  res.sendStatus(200);

  try {
    await handleTelegramUpdate(req.body);
  } catch (err) {
    console.error('[Server] Erro crítico no processamento do webhook:', err);
    // Tenta notificar o usuário sobre a falha, se possível
    try {
      const extracted = telegram.extractPayload(req.body);
      if (extracted.chatId) {
        await telegram.sendMessage(
          extracted.chatId,
          `⚠ No momento nosso sistema de consultas está em manutenção. ` +
            `Por favor, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>. ` +
            `Pedimos desculpas pelo inconveniente.`
        );
      }
    } catch (fallbackErr) {
      console.error('[Server] Falha ao enviar mensagem de fallback:', fallbackErr.message);
    }
  }
});

// =============================================================================
// Rota: Webhook do Bitrix24 (eventos reversos do CRM)
// =============================================================================

app.post('/webhook/bitrix24', async (req, res) => {
  res.sendStatus(200);

  try {
    const event = req.body;
    console.log('[Bitrix24 Webhook] Evento recebido:', event?.event);

    // Aqui podem ser tratados eventos como:
    // - ONCRMDEALUPDATE: quando Alice atualiza um negócio, notificar cliente
    // - ONIMOPENLINESSESSIONSTART: nova sessão de Open Channel iniciada
    // - ONIMOPENLINESSESSIONFINISH: sessão finalizada

    // Exemplo: se Alice finalizar a conversa no Open Channel,
    // podemos notificar o cliente que o atendimento foi encerrado.
    if (event?.event === 'ONIMOPENLINESSESSIONFINISH') {
      // Lógica de encerramento
      console.log('[Bitrix24] Sessão de Open Channel finalizada.');
    }
  } catch (err) {
    console.error('[Server] Erro ao processar webhook do Bitrix24:', err.message);
  }
});

// =============================================================================
// LÓGICA PRINCIPAL: Máquina de estados da conversa
// =============================================================================

/**
 * Roteador principal — recebe o payload do Telegram e decide a ação
 * com base no estado atual da sessão do chat.
 *
 * @param {object} body - Corpo completo do webhook do Telegram
 */
async function handleTelegramUpdate(body) {
  const extracted = telegram.extractPayload(body);
  const { chatId, text, contact, callbackData, callbackQueryId, messageId, firstName, lastName, username } = extracted;

  if (!chatId) {
    console.log('[Server] Payload sem chatId — ignorado.');
    return;
  }

  const session = getSession(chatId);

  // -- Registrar no histórico
  if (text) {
    appendHistory(chatId, 'user', text);
  }

  // -------------------------------------------------------------------
  // Roteamento: CALLBACK_QUERY (botão inline pressionado)
  // -------------------------------------------------------------------
  if (callbackData && callbackQueryId) {
    await telegram.answerCallbackQuery(callbackQueryId); // Remove loading
    await handleCallback(chatId, callbackData, messageId, session);
    return;
  }

  // -------------------------------------------------------------------
  // Roteamento: COMANDO /start (reinicia a conversa)
  // -------------------------------------------------------------------
  if (text === '/start') {
    await handleStart(chatId, firstName);
    return;
  }

  // -------------------------------------------------------------------
  // Roteamento: CONTATO COMPARTILHADO (botão nativo do Telegram)
  // -------------------------------------------------------------------
  if (contact && contact.phone_number) {
    await handleContactReceived(chatId, contact.phone_number, session);
    return;
  }

  // -------------------------------------------------------------------
  // Roteamento: baseado no ESTADO ATUAL da sessão
  // -------------------------------------------------------------------
  switch (session.state) {
    case State.IDLE:
      await handleIdle(chatId, text, firstName);
      break;

    case State.AWAITING_CPF:
      await handleAwaitingCpf(chatId, text, firstName, session);
      break;

    case State.AWAITING_NAME:
      await handleAwaitingName(chatId, text, session);
      break;

    case State.AUTHENTICATED:
      await handleAuthenticated(chatId, text, session);
      break;

    case State.AWAITING_STATUS_CPF:
      await handleStatusLookup(chatId, text, session);
      break;

    case State.AWAITING_CALLBACK_DETAILS:
      await handleCallbackDetails(chatId, text, session);
      break;

    case State.HANDOFF:
      await handleHandoffState(chatId, text);
      break;

    default:
      // Estado desconhecido — reinicia
      updateSession(chatId, State.IDLE);
      await handleIdle(chatId, text, firstName);
  }
}

// =============================================================================
// HANDLERS DE CALLBACK (botões inline)
// =============================================================================

/**
 * Processa cliques nos botões inline do menu.
 */
async function handleCallback(chatId, callbackData, messageId, session) {
  switch (callbackData) {
    // -- Menu Principal --
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
      await handleHandoff(chatId, session);
      break;

    case CALLBACK.MENU_VOLTAR:
      await showMainMenu(chatId, session);
      break;

    default:
      console.log(`[Server] Callback desconhecido: ${callbackData}`);
      await showMainMenu(chatId, session);
  }
}

// =============================================================================
// HANDLERS DE ESTADO
// =============================================================================

// ---------------------------------------------------------------------------
// FASE 1: Reconhecimento Inicial
// ---------------------------------------------------------------------------

/**
 * Estado IDLE — primeiro contato ou após /start.
 * Solicita o contato do Telegram e depois o CPF.
 */
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

  // Solicita o contato do usuário (botão nativo do Telegram)
  await telegram.requestContact(
    chatId,
    '📱 Para prosseguir, por favor compartilhe seu número de telefone clicando no botão abaixo:'
  );

  // Também já pergunta o CPF enquanto espera o contato
  await telegram.sendMessage(
    chatId,
    'Paralelamente, por favor informe seu <b>CPF</b> (apenas números) para consultarmos seu cadastro:'
  );

  updateSession(chatId, State.AWAITING_CPF);
}

// ---------------------------------------------------------------------------
// FASE 1b: Recebimento do Contato do Telegram
// ---------------------------------------------------------------------------

/**
 * Chamado quando o usuário compartilha o contato via botão nativo.
 * Armazena o telefone e avança se o CPF ainda não foi coletado.
 */
async function handleContactReceived(chatId, phoneNumber, session) {
  // Sanitiza e armazena
  const cleanPhone = phoneNumber.replace(/\D/g, '');
  updateSession(chatId, session.state, { phone: cleanPhone });

  await telegram.removeKeyboard(chatId, '✅ Número recebido! Obrigado.');

  // Se já temos CPF, tenta autenticar
  if (session.cpf) {
    await authenticateClient(chatId, session);
  }
  // Caso contrário, o fluxo AWAITING_CPF continua aguardando o CPF
}

// ---------------------------------------------------------------------------
// FASE 1c: Aguardando CPF
// ---------------------------------------------------------------------------

/**
 * Estado AWAITING_CPF — o usuário enviou (esperamos) um CPF.
 */
async function handleAwaitingCpf(chatId, text, firstName, session) {
  const cpfFromMessage = hermesAI.extractCpf(text);

  if (!cpfFromMessage || !hermesAI.isValidCpf(cpfFromMessage)) {
    // Não parece um CPF válido — pode ser que o usuário não entendeu
    await telegram.sendMessage(
      chatId,
      '❌ Não consegui identificar um CPF válido na sua mensagem.\n\n' +
        'Por favor, informe seu <b>CPF</b> com 11 dígitos (ex: 123.456.789-00):'
    );
    return;
  }

  // CPF válido detectado
  updateSession(chatId, State.AWAITING_CPF, { cpf: cpfFromMessage });
  appendHistory(chatId, 'system', `CPF validado: ${cpfFromMessage}`);

  await telegram.sendMessage(chatId, '✅ CPF recebido! Estou consultando seu cadastro...');

  // Se já temos telefone, autentica; senão, pergunta
  if (session.phone) {
    await authenticateClient(chatId, session);
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

/**
 * Estado AWAITING_NAME — cliente novo, precisamos do nome.
 * Após coletar o nome, cria o registro no CRM (Contato + Negócio ou Lead).
 */
async function handleAwaitingName(chatId, text, session) {
  const name = text.trim();
  if (name.length < 2) {
    await telegram.sendMessage(chatId, 'Por favor, informe seu <b>nome completo</b>:');
    return;
  }

  // Atualiza sessão com o nome
  updateSession(chatId, State.AUTHENTICATED, { name });

  // Se é um cliente novo (_pendingCreate), cria o registro no CRM
  if (session._pendingCreate) {
    try {
      await telegram.sendMessage(chatId, '📝 Criando seu cadastro no sistema...');

      // Cria Contato + Negócio no CRM (combo completo)
      const { contactId, dealId } = await bitrix24.createContactAndDeal({
        name,
        phone: session.phone || undefined,
        cpf: session.cpf || undefined,
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
      console.error('[CRM] Erro ao criar Contato+Negócio:', err.message);

      // Fallback: tenta criar apenas um Lead (mais simples)
      try {
        const leadId = await bitrix24.createLead({
          name,
          phone: session.phone || undefined,
          cpf: session.cpf || undefined,
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
        console.error('[CRM] Erro ao criar Lead (fallback):', leadErr.message);
        // Mesmo com erro no CRM, o cliente pode continuar usando o bot
        await telegram.sendMessage(
          chatId,
          `⚠ Tivemos uma dificuldade ao criar seu cadastro, mas você já pode usar nosso atendimento.\n` +
            `Para agilizar, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
        );
        delete session._pendingCreate;
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

/**
 * Busca o cliente no CRM do Bitrix24 por CPF e telefone.
 * Se encontrado, autentica. Se não, cria novo registro.
 */
async function authenticateClient(chatId, session) {
  try {
    await telegram.sendMessage(chatId, '🔍 Consultando nosso sistema...');

    // Busca em Contatos e Leads simultaneamente
    const [contacts, leads] = await Promise.all([
      bitrix24.findContactByCpfOrPhone({ cpf: session.cpf, phone: session.phone }),
      bitrix24.findLeadByCpfOrPhone({ cpf: session.cpf, phone: session.phone }),
    ]);

    const foundContact = contacts?.[0];
    const foundLead = leads?.[0];

    if (foundContact) {
      // -- Cliente encontrado no CRM --
      const contactName =
        [foundContact.NAME, foundContact.LAST_NAME].filter(Boolean).join(' ') || 'Cliente';
      updateSession(chatId, State.AUTHENTICATED, {
        name: contactName,
        crmContactId: foundContact.ID,
      });

      await telegram.sendMessage(
        chatId,
        `✅ <b>Identidade confirmada!</b>\nBem-vindo(a) de volta, ${contactName}.`
      );

      // Busca negócios vinculados para referência
      const deals = await bitrix24.getDealsByContact(foundContact.ID);
      if (deals.length > 0) {
        updateSession(chatId, State.AUTHENTICATED, {
          crmDealId: deals[0].ID,
        });
      }

      await showMainMenu(chatId, getSession(chatId));
    } else if (foundLead) {
      // -- Lead encontrado --
      updateSession(chatId, State.AUTHENTICATED, {
        name: foundLead.NAME || foundLead.TITLE || 'Cliente',
        crmContactId: foundLead.ID,
      });

      await telegram.sendMessage(
        chatId,
        `✅ <b>Cadastro localizado!</b>\nBem-vindo(a), ${foundLead.NAME || foundLead.TITLE || 'Cliente'}.`
      );
      await showMainMenu(chatId, getSession(chatId));
    } else {
      // -- Cliente NOVO: criar registro no CRM --
      await telegram.sendMessage(
        chatId,
        '🆕 Não encontramos seu cadastro em nosso sistema. Vou criar seu registro agora.\n\n' +
          'Por favor, me informe seu <b>nome completo</b>:'
      );

      // Salva os dados já coletados e aguarda o nome
      updateSession(chatId, State.AWAITING_NAME, {
        crmContactId: null,
        crmDealId: null,
      });

      // Assim que o nome chegar (handleAwaitingName), seguimos para criar no CRM
      // A criação acontece em handleAwaitingName → após coletar nome
      // Vamos ajustar: interceptamos após o nome ser coletado

      // Guardamos o callback de criação para após o nome
      session._pendingCreate = true;
    }
  } catch (err) {
    console.error('[Auth] Erro ao consultar CRM:', err.message);
    await telegram.sendMessage(
      chatId,
      `⚠ No momento nosso sistema de consultas está em manutenção. ` +
        `Por favor, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
    );
  }
}

// =============================================================================
// FASE 2: Menu Principal e Interações Autenticadas
// =============================================================================

/**
 * Estado AUTHENTICATED — processa texto livre via IA e encaminha.
 */
async function handleAuthenticated(chatId, text, session) {
  // Classifica a intenção via Hermes AI (ou regex fallback)
  const { intent, confidence } = await hermesAI.classifyIntent(
    text,
    session.history || []
  );

  console.log(`[HermesAI] Intenção: ${intent} (confiança: ${(confidence * 100).toFixed(0)}%)`);

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
      await handleHandoff(chatId, session);
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
      // O cliente enviou CPF mesmo já autenticado — ignora ou atualiza
      await telegram.sendMessage(
        chatId,
        'Seu CPF já foi registrado nesta conversa. Como posso ajudar?'
      );
      await showMainMenu(chatId, session);
      break;

    default:
      // Intenção não clara — oferece o menu
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

/**
 * Exibe o menu híbrido com botões inline.
 * O cliente pode clicar nos botões OU digitar em texto livre (interpretado pela IA).
 */
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

/**
 * Solicita o CPF para consulta de status.
 */
async function promptForStatusCpf(chatId) {
  updateSession(chatId, State.AWAITING_STATUS_CPF);

  await telegram.sendMessage(
    chatId,
    '📋 <b>Consulta de Processo</b>\n\n' +
      'Por favor, informe o <b>CPF</b> associado ao processo que deseja consultar:'
  );
}

/**
 * Busca os negócios/processos vinculados ao CPF informado.
 */
async function handleStatusLookup(chatId, text, session) {
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

    // Busca contato pelo CPF e depois os negócios
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
        'ℹ Não há processos ativos vinculados ao seu CPF no momento.\n\n' +
          'Se acredita que isso é um erro, por favor entre em contato com nossa equipe.'
      );
    } else {
      // Formata a lista de processos
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
    console.error('[Status] Erro ao consultar processos:', err.message);
    await telegram.sendMessage(
      chatId,
      `⚠ No momento nosso sistema de consultas está em manutenção. ` +
        `Por favor, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
    );
    updateSession(chatId, State.AUTHENTICATED);
    await showMainMenu(chatId, getSession(chatId));
  }
}

// =============================================================================
// OPÇÃO 2: Agendamento de Horário
// =============================================================================

/**
 * Exibe as opções de agendamento: link do Booking do CRM.
 */
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

    // Também podemos tentar listar slots disponíveis (se o Resource Booking estiver ativo)
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
    console.error('[Agendamento] Erro:', err.message);
    await telegram.sendMessage(
      chatId,
      `⚠ No momento o sistema de agendamento está em manutenção. ` +
        `Por favor, entre em contato pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
    );
  }

  await showMainMenu(chatId, session);
}

// =============================================================================
// OPÇÃO 3: Solicitar uma Chamada
// =============================================================================

/**
 * Pergunta detalhes sobre a chamada (telefone de contato, preferência de horário).
 */
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

/**
 * Processa os detalhes da chamada e registra a atividade no CRM.
 */
async function handleCallbackDetails(chatId, text, session) {
  try {
    await telegram.sendMessage(chatId, '📞 Registrando sua solicitação de chamada...');

    // Extrai telefone do texto (formato comum brasileiro)
    const phoneMatch = text.match(/(\d{2}\s?\d{4,5}-?\d{4})/);
    const callbackPhone = phoneMatch ? phoneMatch[1] : session.phone || 'Não informado';

    // Cria atividade de chamada no CRM
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
    console.error('[Chamada] Erro ao registrar atividade:', err.message);
    await telegram.sendMessage(
      chatId,
      `⚠ No momento o sistema de registro de chamadas está em manutenção. ` +
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
 *
 * Fluxo:
 * 1. Gera resumo da conversa (Hermes IA)
 * 2. Envia mensagem oculta (whisper) com o resumo para a Alice
 * 3. Notifica Alice via IM interno
 * 4. Transfere o chat do Open Channel para Alice
 * 5. Informa o cliente que um humano assumirá
 */
async function handleHandoff(chatId, session) {
  try {
    await telegram.sendMessage(
      chatId,
      '🔄 <b>Transferindo para atendimento humano...</b>\n\n' +
        'Você será atendido(a) por nossa equipe em instantes. ' +
        'Enquanto isso, pode continuar descrevendo sua necessidade.'
    );

    updateSession(chatId, State.HANDOFF);

    // 1. Gerar resumo da conversa via Hermes IA
    const summary = await hermesAI.generateSummary(session.history || []);

    // 2. Enviar mensagem oculta (whisper) no Canal Aberto
    // O dialogId do Open Channel geralmente é obtido da configuração ou
    // da sessão ativa. Aqui usamos o chatId mapeado conforme a integração.
    const dialogId = `chat${chatId}`;
    await bitrix24.sendWhisperMessage({
      dialogId,
      message: [
        `<b>🤖 Resumo Hermes — Atendimento Telegram</b>`,
        ``,
        `<b>Cliente:</b> ${session.name || 'Não identificado'}`,
        `<b>CPF:</b> ${session.cpf || 'Não informado'}`,
        `<b>Telefone:</b> ${session.phone || 'Não informado'}`,
        ``,
        `<b>📋 Resumo da conversa:</b>`,
        summary,
        ``,
        `<i>Gerado automaticamente pelo Hermes. ${new Date().toLocaleString('pt-BR')}</i>`,
      ].join('\n'),
    });

    // 3. Notificar Alice via chat interno do Bitrix24
    await bitrix24.notifyOperator({
      operatorId: config.bitrix24.operatorAliceId,
      clientName: session.name || 'Cliente não identificado',
      clientCpf: session.cpf || undefined,
      summary,
    });

    // 4. Tentar transferir o chat do Open Channel para Alice
    try {
      await bitrix24.assignChatToOperator({
        chatId: dialogId,
        operatorId: config.bitrix24.operatorAliceId,
      });
    } catch (transferErr) {
      // A transferência pode falhar se o chat ainda não existir no Open Channel
      // Neste caso, Alice receberá a notificação e poderá puxar o chat manualmente
      console.log('[Handoff] Transferência automática indisponível:', transferErr.message);
    }

    // 5. Mensagem final para o cliente
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
    console.error('[Handoff] Erro no transbordo:', err.message);
    await telegram.sendMessage(
      chatId,
      `⚠ Encontramos uma dificuldade ao transferir seu atendimento. ` +
        `Por favor, entre em contato diretamente pelo telefone/WhatsApp: <b>${FALLBACK_PHONE}</b>.`
    );
  }
}

// ---------------------------------------------------------------------------
// Estado HANDOFF — cliente já transferido
// ---------------------------------------------------------------------------

/**
 * Estado HANDOFF — o cliente já foi transferido.
 * Qualquer mensagem adicional é encaminhada como nota.
 */
async function handleHandoffState(chatId, text) {
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

/**
 * Reinicia a conversa — limpa o estado e volta ao IDLE.
 */
async function handleStart(chatId, firstName) {
  deleteSession(chatId);
  const session = getSession(chatId);
  await handleIdle(chatId, null, firstName);
}

// =============================================================================
// Inicialização do Servidor
// =============================================================================

const PORT = config.port;

app.listen(PORT, () => {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  🤖 Hermes Bot — Brandão Correa Assessoria');
  console.log('══════════════════════════════════════════════');
  console.log(`  Servidor:  http://localhost:${PORT}`);
  console.log(`  Webhook:   http://localhost:${PORT}/webhook/telegram`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  Ambiente:  ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Bitrix24:  ${config.bitrix24.domain}`);
  console.log(`  IA Ativa:  ${config.hermesAI.apiKey ? 'Sim' : 'Não (regex fallback)'}`);
  console.log('══════════════════════════════════════════════');
  console.log('');
});

// -- Tratamento de erros não capturados (segurança)
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  // Não derruba o processo, mas loga
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

export default app;
