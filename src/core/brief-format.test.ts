import { describe, it, expect } from 'vitest';
import {
  MAX_ITEMS,
  ageLabel,
  capSections,
  renderBrief,
  topActions,
  type GroupedLines,
} from './brief-format.js';

const NOW = Date.parse('2026-08-14T18:00:00Z');

function grouped(overrides: Partial<GroupedLines> = {}): GroupedLines {
  return { decisions: [], risks: [], meetings: [], opportunities: [], delivery: [], ...overrides };
}

describe('ageLabel', () => {
  it('exprime les durees dans l unite lisible', () => {
    expect(ageLabel('2026-08-14T17:30:00Z', NOW)).toBe("moins d'1 h");
    expect(ageLabel('2026-08-14T15:00:00Z', NOW)).toBe('3 h');
    expect(ageLabel('2026-08-12T18:00:00Z', NOW)).toBe('2 j');
  });
});

describe('capSections', () => {
  it('ne tronque rien tant que le plafond n est pas atteint', () => {
    const { capped, truncated } = capSections(grouped({ decisions: ['a', 'b'] }));
    expect(capped.decisions).toHaveLength(2);
    expect(truncated).toBe(0);
  });

  it('respecte le plafond global de 10 elements', () => {
    const many = Array.from({ length: 8 }, (_, i) => `x${i}`);
    const { capped, truncated } = capSections(
      grouped({ decisions: many, risks: many, opportunities: many }),
    );
    const total = Object.values(capped).reduce((sum, lines) => sum + lines.length, 0);
    expect(total).toBe(MAX_ITEMS);
    expect(truncated).toBe(14);
  });

  it('sert les decisions en premier : le bloquant prime sur l informatif', () => {
    const many = Array.from({ length: 12 }, (_, i) => `d${i}`);
    const { capped } = capSections(grouped({ decisions: many, opportunities: ['o1'] }));
    expect(capped.decisions).toHaveLength(MAX_ITEMS);
    expect(capped.opportunities).toHaveLength(0);
  });
});

describe('topActions', () => {
  it('ne renvoie jamais plus de trois actions', () => {
    const top = topActions(
      grouped({ decisions: ['d'], risks: ['r — source : x'], delivery: ['p — source : y'], opportunities: ['o — source : z'] }),
    );
    expect(top).toHaveLength(3);
  });

  it('retire la mention de source du libelle', () => {
    const top = topActions(grouped({ risks: ['Base injoignable — source : `agent_actions`'] }));
    expect(top[0]).toBe('Corriger : Base injoignable');
  });

  it('ne propose rien quand il n y a rien : pas de remplissage', () => {
    expect(topActions(grouped())).toEqual([]);
  });
});

describe('renderBrief', () => {
  const date = new Date('2026-08-14T08:30:00Z');

  it('dit clairement quand il n y a rien a signaler', () => {
    const text = renderBrief([], 0, date);
    expect(text).toMatch(/Rien à signaler/);
  });

  it('masque une section vide plutot que d afficher un titre creux', () => {
    const text = renderBrief(
      [
        { emoji: '🟣', title: 'Décisions', lines: ['une decision'] },
        { emoji: '🔵', title: 'Rendez-vous', lines: [] },
      ],
      0,
      date,
    );
    expect(text).toContain('Décisions');
    expect(text).not.toContain('Rendez-vous');
  });

  it('annonce ce qui a ete tronque au lieu de le cacher', () => {
    const text = renderBrief([{ emoji: '🟣', title: 'Décisions', lines: ['a'] }], 4, date);
    expect(text).toMatch(/4 élément\(s\) non affiché\(s\)/);
  });
});
