import { describe, expect, it } from 'vitest';
import { parseRoute } from './parse-route.js';

describe('parseRoute', () => {
  it('route par défaut → hermes', () => {
    expect(parseRoute('bonjour équipe')).toEqual({
      target: 'hermes',
      prompt: 'bonjour équipe',
      explicit: false,
    });
  });

  it('ROUTE GROK explicite', () => {
    expect(parseRoute('ROUTE GROK: explique ce KPI')).toEqual({
      target: 'grok',
      prompt: 'explique ce KPI',
      explicit: true,
    });
  });

  it('ROUTE CODEX et ROUTE ANA', () => {
    expect(parseRoute('ROUTE CODEX créer mission')).toMatchObject({
      target: 'codex',
      explicit: true,
    });
    expect(parseRoute('ROUTE ANA')).toMatchObject({ target: 'ana', explicit: true });
  });

  it('ESCALADE DEVIN exacte', () => {
    expect(parseRoute('ESCALADE DEVIN')).toEqual({
      target: 'devin',
      prompt: '',
      explicit: true,
    });
    expect(parseRoute('escalade devin')).toMatchObject({ target: 'hermes', explicit: false });
  });
});
