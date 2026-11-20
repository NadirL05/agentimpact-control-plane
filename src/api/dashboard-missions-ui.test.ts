import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// T6 (docs/TESTING.md) : rendu de l'onglet Missions, sans navigateur ni réseau.
const DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../dashboard');
const MISSIONS_JS = readFileSync(join(DIR, 'missions.js'), 'utf-8');

type Board = {
  renderFilters(c: unknown, a: string): string; renderWeek(w: unknown, p: boolean): string;
  renderItem(i: unknown): string; renderList(d: unknown, f: string): string;
  fmtDuration(s: unknown): string; fmtTokens(n: unknown): string; fmtEur(n: unknown): string; safeUrl(u: unknown): string | null;
  load(o?: unknown): Promise<void>; setFilter(f: string): void; state: { filter: string };
};

function boot(fetchImpl?: (url: string) => Promise<unknown>, withPanel = false) {
  const els: Record<string, { innerHTML: string; textContent: string; hidden: boolean; attrs: Record<string, string>;
    addEventListener: () => void; setAttribute(k: string, v: string): void }> = {};
  const make = () => ({ innerHTML: '', textContent: '', hidden: false, attrs: {} as Record<string, string>,
    addEventListener: () => {}, setAttribute(k: string, v: string) { this.attrs[k] = v; } });
  const ids = ['missions-list', 'missions-filters', 'missions-week', 'missions-updated', 'home-panel', 'tab-home', 'tab-missions'];
  if (withPanel) ids.push('missions-panel');
  for (const id of ids) els[id] = make();
  const window: Record<string, unknown> = {
    document: { getElementById: (id: string) => els[id] ?? null },
    fetch: fetchImpl ?? (async () => { throw new Error('no network'); }),
    location: { href: '', hash: '' }, setInterval: () => 1, clearInterval: () => {},
  };
  vm.runInNewContext(MISSIONS_JS, { window, encodeURIComponent, Date, Math, String, Array, isFinite, isNaN });
  return { board: window.MissionsBoard as Board, els, window };
}

const item = {
  id: '1', ticket: 'AGE-9001', title: 'Filtrer <script>alert(1)</script>', repo: 'test/demo',
  linear_url: 'https://linear.app/x/AGE-9001', category: 'a_relire', created_at: '2026-11-20T10:00:00Z', duration_s: 1260,
  pr_url: 'https://github.com/test/demo/pull/1', pr_state: 'open', tests: 'OK sur le serveur (lint, test)', block: null,
  usage: { tokens: 940528, model: 'gpt-6-astra', cost_eur: 0.78 },
};
const data = { counts: { a_relire: 1, bloquees: 2, en_cours: 0, toutes: 3 }, week: { missions: 3, tokens: 1_200_000, cost_eur: null },
  prices_configured: false, items: [item] };

describe('onglet Missions (T6)', () => {
  it('affiche les 4 filtres avec leurs compteurs, le filtre actif marqué', () => {
    const { board } = boot();
    const html = board.renderFilters(data.counts, 'bloquees');
    for (const label of ['À relire', 'Bloquées', 'En cours', 'Toutes']) expect(html).toContain(label);
    expect(html).toContain('data-filter="bloquees" aria-pressed="true"');
    expect(html.match(/class="count">(\d+)</g)).toEqual(['class="count">1<', 'class="count">2<', 'class="count">0<', 'class="count">3<']);
  });

  it('rend une ligne dépliable avec PR, tests, tokens, et échappe le HTML', () => {
    const { board } = boot();
    const html = board.renderItem(item);
    expect(html).toContain('<details class="mission cat-a_relire">');
    expect(html).toContain('href="https://github.com/test/demo/pull/1" target="_blank" rel="noopener noreferrer">Ouvrir la PR');
    expect(html).toContain('(ouverte)');
    expect(html).toContain('OK sur le serveur (lint, test)');
    expect(html).toContain('941 k');
    expect(html).toContain('0,78 €');
    expect(html).toContain('21 min');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('None');
  });

  it('affiche le blocage expliqué et refuse les liens douteux', () => {
    const { board } = boot();
    const html = board.renderItem({ ...item, category: 'bloquee', pr_url: 'javascript:alert(1)', linear_url: 'https://evil.test/x',
      block: { text: 'Un contrôle échoue (test).', action: 'Ouvrir la PR.' } });
    expect(html).toContain('Pourquoi :</strong> Un contrôle échoue (test).');
    expect(html).toContain('À faire :</strong> Ouvrir la PR.');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('evil.test');
    expect(board.safeUrl('https://github.com/a/b/pull/1" onclick="x')).toBeNull();
  });

  it('états vides par filtre et total de la semaine', () => {
    const { board } = boot();
    expect(board.renderList({ items: [] }, 'a_relire')).toContain('Aucune PR à relire');
    expect(board.renderList({ items: [] }, 'bloquees')).toContain('Aucune mission bloquée');
    expect(board.renderList(null, 'toutes')).toContain('Aucune mission');
    expect(board.renderWeek(data.week, false)).toContain('tarif à configurer');
    expect(board.renderWeek({ missions: 2, tokens: 5000, cost_eur: 1.5 }, true)).toContain('1,50 €');
  });

  it('formats : durée, tokens, euros, valeurs manquantes', () => {
    const { board } = boot();
    expect([board.fmtDuration(42), board.fmtDuration(3600 * 2 + 300), board.fmtDuration(null)]).toEqual(['42 s', '2 h 05', '—']);
    expect([board.fmtTokens(950), board.fmtTokens(12_400), board.fmtTokens(undefined)]).toEqual(['950', '12 k', '—']);
    expect(board.fmtEur(null)).toBe('—');
  });

  it('chargement : squelette puis données ; erreur : message et bouton Réessayer', async () => {
    const calls: string[] = [];
    const { board, els } = boot(async (url) => {
      calls.push(url);
      return { status: 200, ok: true, json: async () => data };
    });
    const pending = board.load();
    expect(els['missions-list'].innerHTML).toContain('skeleton');
    await pending;
    expect(calls[0]).toBe('/dashboard/api/missions?filter=a_relire');
    expect(els['missions-list'].innerHTML).toContain('AGE-9001');
    expect(els['missions-week'].innerHTML).toContain('3</strong> mission(s)');

    const failing = boot(async () => ({ status: 503, ok: false, json: async () => ({}) }));
    await failing.board.load();
    expect(failing.els['missions-list'].innerHTML).toContain('Impossible de charger les missions');
    expect(failing.els['missions-list'].innerHTML).toContain('data-retry');
  });

  it('session expirée : renvoie vers la connexion', async () => {
    const { board, window } = boot(async () => ({ status: 401, ok: false, json: async () => ({}) }));
    await board.load();
    expect((window.location as { href: string }).href).toBe('/dashboard/login.html');
  });

  it('ouvre directement l’onglet Missions avec #missions', () => {
    const { els } = boot(async () => ({ status: 200, ok: true, json: async () => data }), true);
    // Sans #missions, l'accueil est affiché.
    expect(els['missions-panel'].hidden).toBe(true);
    expect(els['home-panel'].hidden).toBe(false);
  });
});
