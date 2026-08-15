import { describe, it, expect } from 'vitest';
import { autopilotApproverName, shouldEngageAutopilot } from './autopilot-rules.js';

const POLICY = { enabled: true, maxFailures24h: 3, maxRejections24h: 2 };

describe('shouldEngageAutopilot', () => {
  it('refuse quand aucune politique n existe : le manuel reste le defaut', () => {
    expect(shouldEngageAutopilot(null, { failures24h: 0, rejections24h: 0 })).toMatchObject({
      engage: false,
      reason: 'policy_disabled',
    });
  });

  it('refuse une politique explicitement desactivee', () => {
    expect(
      shouldEngageAutopilot({ ...POLICY, enabled: false }, { failures24h: 0, rejections24h: 0 }),
    ).toMatchObject({ engage: false, reason: 'policy_disabled' });
  });

  it('engage quand tout est sous les seuils', () => {
    expect(shouldEngageAutopilot(POLICY, { failures24h: 0, rejections24h: 0 })).toEqual({
      engage: true,
    });
  });

  it('coupe au seuil exact d echecs, pas seulement au-dela', () => {
    expect(shouldEngageAutopilot(POLICY, { failures24h: 3, rejections24h: 0 })).toMatchObject({
      engage: false,
      reason: 'circuit_breaker_failures',
    });
    expect(shouldEngageAutopilot(POLICY, { failures24h: 2, rejections24h: 0 })).toEqual({
      engage: true,
    });
  });

  it('coupe au seuil exact de refus humains recents', () => {
    expect(shouldEngageAutopilot(POLICY, { failures24h: 0, rejections24h: 2 })).toMatchObject({
      engage: false,
      reason: 'circuit_breaker_rejections',
    });
  });

  it('les echecs priment si les deux seuils sont atteints en meme temps', () => {
    const verdict = shouldEngageAutopilot(POLICY, { failures24h: 3, rejections24h: 2 });
    expect(verdict).toMatchObject({ reason: 'circuit_breaker_failures' });
  });
});

describe('autopilotApproverName', () => {
  it('prefixe toujours par policy: pour rester distinguable d un humain', () => {
    expect(autopilotApproverName('outreach_send')).toBe('policy:outreach_send');
  });
});
