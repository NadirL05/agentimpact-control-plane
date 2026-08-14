import { describe, it, expect } from 'vitest';
import { FOLDER_MIME, buildMovePlan, type DriveFileLike } from './drive-plan.js';

const DEST = 'dossier-cible';

function file(overrides: Partial<DriveFileLike> = {}): DriveFileLike {
  return {
    id: 'f1',
    name: 'compte-rendu.docx',
    mimeType: 'application/vnd.google-apps.document',
    parents: ['dossier-source'],
    ...overrides,
  };
}

describe('buildMovePlan', () => {
  it('ne deplace jamais un dossier : ca emporterait tout son contenu', () => {
    const plan = buildMovePlan([file({ mimeType: FOLDER_MIME })], DEST);
    expect(plan).toHaveLength(0);
  });

  it('ignore un fichier deja dans le dossier cible', () => {
    const plan = buildMovePlan([file({ parents: [DEST] })], DEST);
    expect(plan).toHaveLength(0);
  });

  it('deplace un fichier present dans plusieurs dossiers dont la cible', () => {
    const plan = buildMovePlan([file({ parents: ['autre', DEST] })], DEST);
    expect(plan).toHaveLength(0);
  });

  it('capture tous les parents d origine : le rollback en depend', () => {
    const plan = buildMovePlan([file({ parents: ['a', 'b'] })], DEST);
    expect(plan[0].from_parents).toEqual(['a', 'b']);
  });

  it('gere un fichier sans parent connu sans planter', () => {
    const plan = buildMovePlan([file({ parents: undefined })], DEST);
    expect(plan[0].from_parents).toEqual([]);
  });

  it('respecte le plafond de lot', () => {
    const files = Array.from({ length: 50 }, (_, i) => file({ id: `f${i}` }));
    expect(buildMovePlan(files, DEST, 20)).toHaveLength(20);
    expect(buildMovePlan(files, DEST, 5)).toHaveLength(5);
  });

  it('un lot vide donne un plan vide, pas une erreur', () => {
    expect(buildMovePlan([], DEST)).toEqual([]);
  });

  it('toutes les cibles pointent le meme dossier : un seul dossier par lot', () => {
    const plan = buildMovePlan([file({ id: 'a' }), file({ id: 'b' })], DEST);
    expect(new Set(plan.map((m) => m.to_parent)).size).toBe(1);
  });
});
