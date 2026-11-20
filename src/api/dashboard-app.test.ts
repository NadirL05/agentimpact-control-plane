import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// T2 (docs/TESTING.md) : une erreur de chargement s'affiche comme une erreur, jamais comme une liste vide.
const APP_JS = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '../dashboard/app.js'), 'utf-8');

function runApp(responses: Record<string, { status: number; body?: unknown } | 'network'>) {
  const els: Record<string, { innerHTML: string; textContent: string; value: string; addEventListener: () => void }> = {};
  const document = {
    getElementById(id: string) {
      els[id] ??= { innerHTML: '', textContent: '', value: '', addEventListener: () => {} };
      return els[id];
    },
  };
  const fetch = async (url: string) => {
    const path = new URL(url).pathname;
    const r = responses[path];
    if (!r || r === 'network') throw new TypeError('Failed to fetch');
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
  };
  const context = { document, fetch, window: { location: { origin: 'https://pilotage.test', href: '' } }, console, URL };
  vm.runInNewContext(APP_JS, context);
  return { els, settle: () => new Promise((r) => setTimeout(r, 10)) };
}

const ok = (items: unknown[]) => ({ status: 200, body: { count: items.length, items } });

describe('dashboard app.js (T2)', () => {
  it('affiche « Impossible de charger » pour une erreur réseau ou serveur, « Aucun » pour un vide réel', async () => {
    const { els, settle } = runApp({ '/profiles': 'network', '/policies': { status: 500 }, '/workflows': ok([]) });
    await settle();
    expect(els['profiles-content'].innerHTML).toContain('Impossible de charger');
    expect(els['policies-content'].innerHTML).toContain('Impossible de charger');
    expect(els['workflows-content'].innerHTML).toContain('Aucun workflow');
    expect(els.status.textContent).toContain('Erreur');
  });

  it('affiche les éléments quand tout répond', async () => {
    const policy = { id: 'p1', name: 'Politique <b>', description: 'd', rules: [] };
    const { els, settle } = runApp({ '/profiles': ok([]), '/policies': ok([policy]), '/workflows': ok([]) });
    await settle();
    expect(els['policies-content'].innerHTML).toContain('Politique &lt;b&gt;');
    expect(els.status.textContent).toContain('OK');
  });
});
