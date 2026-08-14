import { describe, it, expect } from 'vitest';
import { canSend, classifyReply, dailySendLimit } from './outreach-guards.js';

describe('dailySendLimit', () => {
  it('reste bas les 3 premiers jours', () => {
    expect(dailySendLimit(0)).toBe(5);
    expect(dailySendLimit(2)).toBe(5);
  });

  it('augmente par palier, jamais brutalement', () => {
    expect(dailySendLimit(3)).toBe(10);
    expect(dailySendLimit(6)).toBe(10);
    expect(dailySendLimit(7)).toBe(20);
    expect(dailySendLimit(13)).toBe(20);
    expect(dailySendLimit(14)).toBe(40);
    expect(dailySendLimit(29)).toBe(40);
  });

  it('plafonne a 60/jour meme longtemps apres le lancement', () => {
    expect(dailySendLimit(30)).toBe(60);
    expect(dailySendLimit(1000)).toBe(60);
  });

  it('un domaine pas encore lance ne peut rien envoyer', () => {
    expect(dailySendLimit(-1)).toBe(0);
  });
});

describe('canSend', () => {
  it('bloque toujours une adresse supprimee, meme sous quota', () => {
    const verdict = canSend({ isSuppressed: true, sentToday: 0, daysSinceLaunch: 30 });
    expect(verdict).toMatchObject({ allowed: false, reason: 'suppressed', httpStatus: 403 });
  });

  it('la suppression prime sur le quota : les deux motifs ne se melangent jamais', () => {
    const verdict = canSend({ isSuppressed: true, sentToday: 999, daysSinceLaunch: 30 });
    expect(verdict).toMatchObject({ reason: 'suppressed' });
  });

  it('bloque au quota exact, pas juste au-dela', () => {
    expect(canSend({ isSuppressed: false, sentToday: 5, daysSinceLaunch: 0 })).toMatchObject({
      allowed: false,
      reason: 'quota_exceeded',
      httpStatus: 429,
    });
    expect(canSend({ isSuppressed: false, sentToday: 4, daysSinceLaunch: 0 })).toEqual({
      allowed: true,
    });
  });
});

describe('classifyReply', () => {
  it('detecte un desabonnement explicite', () => {
    expect(classifyReply('Merci de me desabonner de cette liste')).toBe('unsubscribe');
    expect(classifyReply('STOP')).toBe('unsubscribe');
  });

  it('detecte un interet explicite', () => {
    expect(classifyReply('Oui je suis interesse, on peut se caler 30min ?')).toBe('interested');
  });

  it('detecte un report plutot qu un refus', () => {
    expect(classifyReply('Pas maintenant, rappelez-moi dans 3 mois')).toBe('later');
  });

  it('detecte un refus explicite', () => {
    expect(classifyReply('Non merci, pas interesse')).toBe('not_interested');
  });

  it('un simple "?" est traite comme une question, pas ignore', () => {
    expect(classifyReply('Vous faites quoi exactement ?')).toBe('question');
  });

  it('ne devine jamais sur un texte ambigu : unknown plutot qu un faux positif', () => {
    expect(classifyReply('Merci pour votre message.')).toBe('unknown');
    expect(classifyReply('')).toBe('unknown');
  });

  it('un refus prime sur un mot "interesse" cite en negation', () => {
    // Cas limite volontairement documente : la regle est simple et peut se
    // tromper ici. Mieux vaut un faux "not_interested" verifiable par
    // relecture humaine qu'une classification illisible.
    expect(classifyReply('pas interesse, merci')).toBe('not_interested');
  });
});
