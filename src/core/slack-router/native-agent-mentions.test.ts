import { describe, expect, it } from 'vitest';
import {
  extractSlackMentionUserIds,
  messageMentionsNativeAgent,
  parseSlackNativeAgentUserIds,
} from './native-agent-mentions.js';

describe('parseSlackNativeAgentUserIds', () => {
  it('accepte une liste CSV valide', () => {
    const ids = parseSlackNativeAgentUserIds('UAAA111, UBBB222', { requireNonEmpty: false });
    expect([...ids]).toEqual(['UAAA111', 'UBBB222']);
  });

  it('normalise la casse', () => {
    const ids = parseSlackNativeAgentUserIds('uaaa111', { requireNonEmpty: false });
    expect([...ids]).toEqual(['UAAA111']);
  });

  it('rejette un ID malformé', () => {
    expect(() =>
      parseSlackNativeAgentUserIds('not-a-slack-id', { requireNonEmpty: false }),
    ).toThrow(/invalid_slack_native_agent_user_id/);
  });

  it('fail-closed si liste absente et requireNonEmpty', () => {
    expect(() => parseSlackNativeAgentUserIds(undefined, { requireNonEmpty: true })).toThrow(
      /missing_required_env:SLACK_NATIVE_AGENT_USER_IDS/,
    );
  });

  it('autorise une liste vide hors production', () => {
    const ids = parseSlackNativeAgentUserIds('', { requireNonEmpty: false });
    expect(ids.size).toBe(0);
  });
});

describe('extractSlackMentionUserIds', () => {
  it('extrait les tokens Slack <@U…>', () => {
    expect(extractSlackMentionUserIds('Salut <@U123ABC|Cursor> peux-tu aider ?')).toEqual([
      'U123ABC',
    ]);
  });

  it('ignore le faux texte @Cursor sans token Slack', () => {
    expect(extractSlackMentionUserIds('@Cursor peux-tu aider ?')).toEqual([]);
  });
});

describe('messageMentionsNativeAgent', () => {
  const nativeIds = new Set(['UCURSOR01', 'UCODEX001', 'UDEVIN001']);

  it('détecte une mention native exacte', () => {
    expect(messageMentionsNativeAgent('Question pour <@UCURSOR01|Cursor>', nativeIds)).toBe(true);
  });

  it('ignore le texte libre sans token', () => {
    expect(messageMentionsNativeAgent('@Cursor regarde ce bug', nativeIds)).toBe(false);
  });
});
