import { describe, expect, it } from 'vitest';
import {
  detectLongRunningMission,
  extractMissionTitle,
  formatAsyncMissionAck,
  mapInboxStatusToUx,
} from './long-running-mission.js';

describe('detectLongRunningMission', () => {
  it('laisse les pings courts en sync', () => {
    expect(detectLongRunningMission('bonjour Hermès').mode).toBe('sync');
    expect(detectLongRunningMission('ROUTE ANA: résumé court').mode).toBe('sync');
  });

  it('détecte une mission nommée IMANE-PROJECT-AUDIT-V1', () => {
    const prompt = `Mission réelle V1 — projet Imane

Projet :
https://github.com/NadirL05/imane-projet

Objectif : analyses le repository

Nom de mission :
IMANE-PROJECT-AUDIT-V1
`;
    const d = detectLongRunningMission(prompt);
    expect(d.mode).toBe('async');
    expect(d.missionTitle).toBe('IMANE-PROJECT-AUDIT-V1');
    expect(d.reason).toBe('named_mission');
  });

  it('détecte ASYNC MISSION explicite', () => {
    const d = detectLongRunningMission('ASYNC MISSION: audit profond');
    expect(d.mode).toBe('async');
    expect(d.reason).toBe('explicit_async');
  });

  it('détecte github + audit sans titre', () => {
    const d = detectLongRunningMission(
      'Fais un audit du repository https://github.com/NadirL05/imane-projet et liste la dette technique',
    );
    expect(d.mode).toBe('async');
    expect(d.reason).toBe('github_audit');
  });
});

describe('extractMissionTitle / ACK', () => {
  it('extrait le titre et formate l ACK', () => {
    expect(extractMissionTitle('Nom de mission : FOO-BAR-V1')).toBe('FOO-BAR-V1');
    expect(
      formatAsyncMissionAck({
        missionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        agent: 'hermes',
        status: 'queued',
        missionTitle: 'IMANE-PROJECT-AUDIT-V1',
      }),
    ).toContain('ID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('mappe les statuts inbox → UX', () => {
    expect(mapInboxStatusToUx('pending')).toBe('queued');
    expect(mapInboxStatusToUx('processing')).toBe('running');
    expect(mapInboxStatusToUx('done')).toBe('completed');
    expect(mapInboxStatusToUx('timeout')).toBe('timeout');
  });
});
