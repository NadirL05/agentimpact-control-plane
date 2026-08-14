import { describe, it, expect } from 'vitest';
import { AGENT_LABEL, hasTestFiles, renderIssueBody, type IssueSpec } from './github-spec.js';

function spec(overrides: Partial<IssueSpec> = {}): IssueSpec {
  return {
    repo: 'NadirL05/agentimpact-control-plane',
    title: 'Ajouter X',
    need: 'Besoin exprime par le client',
    acceptance_criteria: ['Le bouton existe', 'Le test passe'],
    ...overrides,
  };
}

describe('renderIssueBody', () => {
  it('rend chaque critere en case a cocher', () => {
    const body = renderIssueBody(spec());
    expect(body).toContain('- [ ] Le bouton existe');
    expect(body).toContain('- [ ] Le test passe');
  });

  it('signale explicitement des cas limites absents au lieu de les taire', () => {
    const body = renderIssueBody(spec({ edge_cases: [] }));
    expect(body).toMatch(/à compléter avant de lancer le développement/);
  });

  it('liste les cas limites fournis', () => {
    const body = renderIssueBody(spec({ edge_cases: ['token absent'] }));
    expect(body).toContain('- token absent');
  });

  it('rappelle que le merge reste humain', () => {
    expect(renderIssueBody(spec())).toMatch(/merge reste manuel/);
  });

  it('le label agent-ready est bien la valeur attendue', () => {
    expect(AGENT_LABEL).toBe('agent-ready');
  });
});

describe('hasTestFiles', () => {
  it('reconnait les conventions de nommage courantes', () => {
    expect(hasTestFiles(['src/api/server.test.ts'])).toBe(true);
    expect(hasTestFiles(['src/foo.spec.js'])).toBe(true);
    expect(hasTestFiles(['tests/integration.py'])).toBe(true);
    expect(hasTestFiles(['app/__tests__/a.tsx'])).toBe(true);
  });

  it('ne confond pas un fichier qui parle de test avec un test', () => {
    expect(hasTestFiles(['docs/testing-strategy.md'])).toBe(false);
    expect(hasTestFiles(['src/contest.ts'])).toBe(false);
  });

  it('une PR sans fichier ne passe pas pour testee', () => {
    expect(hasTestFiles([])).toBe(false);
  });
});
