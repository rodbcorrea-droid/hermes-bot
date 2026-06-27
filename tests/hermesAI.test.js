// =============================================================================
// tests/hermesAI.test.js — testes para extracao e validacao de CPF, regexClassify
// =============================================================================

import './setup.js';
import { describe, it, expect } from 'vitest';
import {
  extractCpf,
  isValidCpf,
  regexClassify,
  Intent,
  buildFallbackSummary,
} from '../services/hermesAI.js';

describe('extractCpf', () => {
  it('extrai CPF formatado', () => {
    expect(extractCpf('Meu CPF é 123.456.789-09')).toBe('12345678909');
  });

  it('extrai CPF apenas digitos', () => {
    expect(extractCpf('CPF: 12345678909')).toBe('12345678909');
  });

  it('extrai CPF com hífen mas sem pontos', () => {
    expect(extractCpf('123456789-09')).toBe('12345678909');
  });

  it('extrai CPF cercado por texto', () => {
    expect(extractCpf('por favor consulte 111.444.777-35 urgente')).toBe('11144477735');
  });

  it('retorna null para texto sem CPF', () => {
    expect(extractCpf('olá, gostaria de agendar')).toBeNull();
  });

  it('retorna null para string vazia', () => {
    expect(extractCpf('')).toBeNull();
    expect(extractCpf(null)).toBeNull();
    expect(extractCpf(undefined)).toBeNull();
  });

  it('NÃO extrai números longos como CPF (word boundary)', () => {
    // Antes do fix, regex sem \b capturava dígitos no meio de palavras.
    // Após o fix com \b, "abc12345678901xyz" (12 dígitos) NÃO deve casar,
    // pois não há boundary entre "abc" e "1".
    // Nota: "abc123.456.789-01xyz" com pontuação cria boundaries reais,
    // então este caso específico ainda casa (correto). Testamos sem pontuação.
    expect(extractCpf('protocolo1234567890123')).toBeNull();
  });
});

describe('isValidCpf', () => {
  it('valida CPF real com digitos verificadores corretos', () => {
    // CPF válido conhecido: 529.982.247-25
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
  });

  it('rejeita CPF com digitos verificadores errados', () => {
    expect(isValidCpf('529.982.247-26')).toBe(false);
    expect(isValidCpf('12345678900')).toBe(false);
  });

  it('rejeita CPF com todos digitos iguais', () => {
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('000.000.000-00')).toBe(false);
    expect(isValidCpf('999.999.999-99')).toBe(false);
  });

  it('rejeita CPF com tamanho errado', () => {
    expect(isValidCpf('123456')).toBe(false);
    expect(isValidCpf('123456789012345')).toBe(false);
    expect(isValidCpf('')).toBe(false);
    expect(isValidCpf(null)).toBe(false);
    expect(isValidCpf(undefined)).toBe(false);
  });

  it('ignora pontuação na validação', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529 982 247 25')).toBe(true);
  });
});

describe('regexClassify', () => {
  it('classifica CPF como FORNECER_CPF', () => {
    const result = regexClassify('Meu CPF é 529.982.247-25');
    expect(result.intent).toBe(Intent.FORNECER_CPF);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('classifica saudação', () => {
    expect(regexClassify('oi').intent).toBe(Intent.SAUDACAO);
    expect(regexClassify('olá').intent).toBe(Intent.SAUDACAO);
    expect(regexClassify('ola').intent).toBe(Intent.SAUDACAO);
    expect(regexClassify('oi!').intent).toBe(Intent.SAUDACAO);
    expect(regexClassify('bom dia').intent).toBe(Intent.SAUDACAO);
    expect(regexClassify('boa noite').intent).toBe(Intent.SAUDACAO);
    expect(regexClassify('hey').intent).toBe(Intent.SAUDACAO);
  });

  it('classifica falar com equipe', () => {
    expect(regexClassify('quero falar com um humano').intent).toBe(Intent.FALAR_EQUIPE);
    expect(regexClassify('preciso de atendente').intent).toBe(Intent.FALAR_EQUIPE);
    expect(regexClassify('me transfira para live chat').intent).toBe(Intent.FALAR_EQUIPE);
  });

  it('classifica status do processo', () => {
    expect(regexClassify('qual o status do meu processo?').intent).toBe(Intent.STATUS_PROCESSO);
    expect(regexClassify('como está meu caso?').intent).toBe(Intent.STATUS_PROCESSO);
    expect(regexClassify('qual a previsão?').intent).toBe(Intent.STATUS_PROCESSO);
  });

  it('classifica agendamento', () => {
    expect(regexClassify('quero agendar uma consulta').intent).toBe(Intent.AGENDAMENTO);
    expect(regexClassify('qual horário disponível?').intent).toBe(Intent.AGENDAMENTO);
  });

  it('classifica solicitar chamada', () => {
    expect(regexClassify('quero ligar para vocês').intent).toBe(Intent.SOLICITAR_CHAMADA);
    expect(regexClassify('me liga por favor').intent).toBe(Intent.SOLICITAR_CHAMADA);
    expect(regexClassify('solicitar callback').intent).toBe(Intent.SOLICITAR_CHAMADA);
    expect(regexClassify('preciso receber uma ligação').intent).toBe(Intent.SOLICITAR_CHAMADA);
    expect(regexClassify('meu telefone é 9988-7766').intent).toBe(Intent.SOLICITAR_CHAMADA);
  });

  it('classifica menu principal', () => {
    expect(regexClassify('voltar ao menu').intent).toBe(Intent.MENU_PRINCIPAL);
    expect(regexClassify('opções').intent).toBe(Intent.MENU_PRINCIPAL);
  });

  it('classifica mensagem longa como dúvida complexa', () => {
    // Mensagem longa sem palavras-chave de outras intenções (sem "processo",
    // "agendar", "ligar", "humano", etc.) cai em DUVIDA_COMPLEXA.
    const longa = 'Olá, eu tenho uma dúvida complexa sobre a legislação brasileira referente a herança e divisão de bens em casos de divórcio posterior com filhos menores envolvidos e precisaria de orientação.';
    expect(regexClassify(longa).intent).toBe(Intent.DUVIDA_COMPLEXA);
  });

  it('classifica mensagem curta sem intenção como OUTRO', () => {
    expect(regexClassify('xyz').intent).toBe(Intent.OUTRO);
  });

  it('não quebra com input vazio', () => {
    expect(regexClassify('').intent).toBe(Intent.OUTRO);
    expect(regexClassify(null).intent).toBe(Intent.OUTRO);
  });
});

describe('buildFallbackSummary', () => {
  it('retorna mensagem para histórico vazio', () => {
    expect(buildFallbackSummary([])).toContain('sem histórico');
    expect(buildFallbackSummary(null)).toContain('sem histórico');
  });

  it('inclui contagem de mensagens', () => {
    const history = [
      { role: 'user', content: 'oi', timestamp: Date.now() },
      { role: 'bot', content: 'olá', timestamp: Date.now() },
      { role: 'user', content: 'ajuda', timestamp: Date.now() },
    ];
    const summary = buildFallbackSummary(history);
    expect(summary).toContain('3 mensagens');
    expect(summary).toContain('ajuda');
  });
});
