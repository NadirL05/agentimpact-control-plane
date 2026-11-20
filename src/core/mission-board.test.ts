import { describe, expect, it } from 'vitest';
import {
  categoryOf, explainBlock, matchesFilter, parsePrices, toBoardItem, usageOf, weekTotals, type MissionRow,
} from './mission-board.js';

// T4 (docs/TESTING.md) : logique de l'onglet Missions, données fictives.
function row(over: Partial<MissionRow> = {}): MissionRow {
  return {
    id: '00000000-0000-4000-8000-000000000001', source_id: 'AGE-9001', source_url: 'https://linear.app/x/AGE-9001',
    title: 'AGE-9001 Filtrer le tableau', status: 'completed', action_status: 'executed',
    payload: { repo: 'test/demo', linear_issue: 'AGE-9001' },
    result: { pr_url: 'https://github.com/test/demo/pull/1', delivery: 'pull_request', test_mode: 'server',
      server_checks: ['lint', 'test'], usage: { codex: { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 5_000, model: 'm1' }, review: { input_tokens: 100, output_tokens: 50, cost_usd: 0.5 } } },
    error_message: null, created_at: '2026-11-20T10:00:00Z', processed_at: '2026-11-20T10:20:00Z', ...over,
  };
}
const NOW = new Date('2026-11-20T12:00:00Z');

describe('mission-board', () => {
  it('classe les missions', () => {
    expect(categoryOf(row())).toBe('a_relire');
    expect(categoryOf(row({ result: { pr_url: 'u', delivery: 'merged' } }))).toBe('terminee');
    expect(categoryOf(row({ result: {} }))).toBe('terminee');
    expect(categoryOf(row({ status: 'failed' }))).toBe('bloquee');
    expect(categoryOf(row({ status: 'rejected' }))).toBe('refusee');
    expect(categoryOf(row({ status: 'in_progress' }))).toBe('en_cours');
    expect(categoryOf(row({ status: 'pending', action_status: 'approved' }))).toBe('en_cours');
    expect(categoryOf(row({ status: 'pending', action_status: 'proposed' }))).toBe('en_attente');
    expect(matchesFilter('en_attente', 'en_cours')).toBe(true);
    expect(matchesFilter('refusee', 'bloquees')).toBe(false);
    expect(matchesFilter('refusee', 'toutes')).toBe(true);
  });

  it('explique les blocages sans recopier le message technique', () => {
    const b = explainBlock(row({ status: 'failed', error_message: 'RuntimeError:server_tests_failed:regression:lint,test' }));
    expect(b?.text).toBe('Un contrôle qui passait avant la mission échoue maintenant (lint, test).');
    expect(explainBlock(row({ status: 'failed', error_message: 'RuntimeError:worker_timeout_no_pr' }))?.text).toContain('30 minutes');
    expect(explainBlock(row({ status: 'failed', error_message: null, result: { error: 'RuntimeError:ci_wait_timeout' } }))?.text).toContain('CI GitHub');
    const unknown = explainBlock(row({ status: 'failed', error_message: 'Traceback /etc/secret' }));
    expect(unknown?.text).toBe('La mission a été arrêtée pour une raison non répertoriée.');
    expect(JSON.stringify(unknown)).not.toContain('/etc');
    expect(explainBlock(row())).toBeNull();
  });

  it('calcule tokens et coût estimé, ou « — » sans tarif', () => {
    const prices = parsePrices(JSON.stringify({ models: { m1: { input: 1, cached_input: 0.1, output: 10 } }, usd_to_eur: 0.9 }));
    // (200k×1 + 800k×0,1 + 5k×10)/1M = 0,33 € ; relecture 0,5 $ × 0,9 = 0,45 € → 0,78 €
    expect(usageOf(row(), prices)).toEqual({ tokens: 1_005_150, model: 'm1', cost_eur: 0.78 });
    expect(usageOf(row(), null).cost_eur).toBeNull();
    expect(usageOf(row({ result: {} }), prices)).toEqual({ tokens: null, model: null, cost_eur: null });
    expect(parsePrices('pas du json')).toBeNull();
    expect(parsePrices(JSON.stringify({ models: { m1: { input: -1, output: 'x' } } }))?.models.m1).toEqual({});
    const fallback = parsePrices(JSON.stringify({ models: { default: { input: 1, output: 1 } } }));
    expect(usageOf(row(), fallback).cost_eur).not.toBeNull();
  });

  it('construit la ligne : ticket, durée, tests, jamais « None »', () => {
    const item = toBoardItem(row(), null, NOW);
    expect(item).toMatchObject({ ticket: 'AGE-9001', title: 'Filtrer le tableau', repo: 'test/demo', duration_s: 1200,
      tests: 'OK sur le serveur (lint, test)', category: 'a_relire' });
    const running = toBoardItem(row({ status: 'in_progress', processed_at: null, result: null }), null, NOW);
    expect(running.duration_s).toBe(7200);
    expect(running.tests).toBeNull();
    expect(JSON.stringify(toBoardItem(row({ payload: null, result: null }), null, NOW))).not.toContain('None');
    expect(toBoardItem(row({ source_id: 'AGE-9002-essai-2', payload: {} }), null, NOW).ticket).toBe('AGE-9002');
    expect(toBoardItem(row({ result: { test_mode: 'ci-only', ci_checks: ['a', 'b'], pr_url: 'u' } }), null, NOW).tests).toBe('CI GitHub verte (a ; b)');
  });

  it('totalise la semaine', () => {
    const prices = parsePrices(JSON.stringify({ models: { m1: { input: 1, output: 1 } } }));
    const items = [toBoardItem(row(), prices, NOW), toBoardItem(row({ created_at: '2026-11-01T00:00:00Z' }), prices, NOW)];
    const week = weekTotals(items, NOW);
    expect(week.missions).toBe(1);
    expect(week.tokens).toBe(1_005_150);
    expect(week.cost_eur).toBeCloseTo(1.0, 2);
  });
});
