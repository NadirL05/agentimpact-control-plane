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

  it('smoke V1 exact : ROUTE CODEX avec deux-points', () => {
    expect(
      parseRoute(
        'ROUTE CODEX: créer une proposition de test V1 pour revue Nadir uniquement',
      ),
    ).toEqual({
      target: 'codex',
      prompt: 'créer une proposition de test V1 pour revue Nadir uniquement',
      explicit: true,
    });
  });

  it('mention bot en tête n’empêche pas ROUTE CODEX', () => {
    expect(
      parseRoute(
        '<@UROUTER01> ROUTE CODEX: créer une proposition de test V1 pour revue Nadir uniquement',
      ),
    ).toEqual({
      target: 'codex',
      prompt: 'créer une proposition de test V1 pour revue Nadir uniquement',
      explicit: true,
    });
  });

  it('ROUTE <@U…|Codex>: (mot-clé remplacé par mention) reste hors Codex', () => {
    expect(parseRoute('ROUTE <@UCODEX01|Codex>: créer une proposition')).toMatchObject({
      target: 'hermes',
      explicit: false,
    });
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
