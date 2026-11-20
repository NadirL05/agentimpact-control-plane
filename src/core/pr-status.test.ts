import { describe, expect, it } from 'vitest';
import { createPrStatusClient, parsePrUrl } from './pr-status.js';

// T5 (docs/TESTING.md) : état des PR, GitHub simulé, aucun appel réseau.
function fakeFetch(responses: Record<string, { status: number; body?: unknown } | 'throw'>) {
  const calls: Array<{ url: string; auth: string }> = [];
  const fn = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, auth: init.headers.Authorization });
    const r = responses[url];
    if (!r || r === 'throw') throw new Error('network down');
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  return { fn, calls };
}
const API = 'https://api.github.com/repos';

describe('pr-status (T5)', () => {
  it('reconnaît seulement les PR des dépôts autorisés', () => {
    expect(parsePrUrl('https://github.com/NadirL05/lotsolver/pull/12')).toEqual({ owner: 'NadirL05', repo: 'lotsolver', number: 12 });
    expect(parsePrUrl('https://github.com/ERP-AxENR/home-eco-enr/pull/136')).not.toBeNull();
    for (const bad of ['https://github.com/ERP-AxENR/autre/pull/1', 'https://github.com/evil/x/pull/1',
      'https://github.com/NadirL05/x/pull/1/files', 'http://github.com/NadirL05/x/pull/1', 'https://github.com/NadirL05/../x/pull/1', 42, null]) {
      expect(parsePrUrl(bad), String(bad)).toBeNull();
    }
  });

  it('distingue ouverte, fusionnée et fermée', async () => {
    const { fn } = fakeFetch({
      [`${API}/NadirL05/a/pulls/1`]: { status: 200, body: { state: 'open', merged: false } },
      [`${API}/NadirL05/a/pulls/2`]: { status: 200, body: { state: 'closed', merged: true } },
      [`${API}/NadirL05/a/pulls/3`]: { status: 200, body: { state: 'closed', merged: false, merged_at: null } },
    });
    const client = createPrStatusClient({ token: 't', fetch: fn });
    expect(await client.state('https://github.com/NadirL05/a/pull/1')).toBe('open');
    expect(await client.state('https://github.com/NadirL05/a/pull/2')).toBe('merged');
    expect(await client.state('https://github.com/NadirL05/a/pull/3')).toBe('closed');
  });

  it('ne contacte jamais GitHub pour un dépôt hors liste ou sans jeton', async () => {
    const { fn, calls } = fakeFetch({});
    expect(await createPrStatusClient({ token: 't', fetch: fn }).state('https://github.com/evil/x/pull/1')).toBe('unknown');
    expect(await createPrStatusClient({ fetch: fn }).state('https://github.com/NadirL05/a/pull/1')).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('GitHub en panne ou en erreur → inconnu', async () => {
    const { fn } = fakeFetch({ [`${API}/NadirL05/a/pulls/5`]: { status: 404 } });
    const client = createPrStatusClient({ token: 't', fetch: fn });
    expect(await client.state('https://github.com/NadirL05/a/pull/4')).toBe('unknown');
    expect(await client.state('https://github.com/NadirL05/a/pull/5')).toBe('unknown');
  });

  it('respecte le cache de 5 min (1 min pour un inconnu)', async () => {
    let t = 0;
    const { fn, calls } = fakeFetch({ [`${API}/NadirL05/a/pulls/1`]: { status: 200, body: { state: 'open' } } });
    const client = createPrStatusClient({ token: 't', fetch: fn, now: () => t });
    await client.state('https://github.com/NadirL05/a/pull/1');
    t = 4 * 60 * 1000;
    await client.state('https://github.com/NadirL05/a/pull/1');
    expect(calls).toHaveLength(1);
    t = 6 * 60 * 1000;
    await client.state('https://github.com/NadirL05/a/pull/1');
    expect(calls).toHaveLength(2);
    expect(calls[0].auth).toBe('Bearer t');
  });
});
