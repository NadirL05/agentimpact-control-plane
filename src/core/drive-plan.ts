/**
 * Plan de classement Drive (semaine 5), sans I/O.
 *
 * Deux exclusions structurelles, testees : on ne deplace jamais un dossier
 * (ca deplacerait tout son contenu sans que l'humain l'ait vu), et jamais un
 * fichier deja dans le dossier cible (deplacement nul, bruit dans l'audit).
 */

export const MAX_BATCH_DEFAULT = 20;

export type DriveFileLike = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
};

export type MovePlan = {
  file_id: string;
  name: string;
  from_parents: string[];
  to_parent: string;
};

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function buildMovePlan(
  files: DriveFileLike[],
  destination: string,
  maxBatch: number = MAX_BATCH_DEFAULT,
): MovePlan[] {
  return files
    .filter((file) => file.mimeType !== FOLDER_MIME)
    .filter((file) => !(file.parents ?? []).includes(destination))
    .slice(0, maxBatch)
    .map((file) => ({
      file_id: file.id,
      name: file.name,
      from_parents: file.parents ?? [],
      to_parent: destination,
    }));
}
