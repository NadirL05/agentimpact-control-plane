import { readFileSync } from 'node:fs';

/** Lit un secret depuis un fichier LoadCredential (prod) ou variable directe (tests/dev). */
export function readRequiredSecret(
  fileEnv: string,
  label: string,
  directEnv?: string,
): string {
  const file = process.env[fileEnv]?.trim();
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      throw new Error(`unreadable_${label}_file`);
    }
  }
  if (directEnv) {
    const direct = process.env[directEnv]?.trim();
    if (direct) return direct;
  }
  throw new Error(`missing_${label}`);
}

/** Lit un secret optionnel (ex. bridge token pour route Codex). */
export function readOptionalSecret(fileEnv: string, directEnv?: string): string {
  const file = process.env[fileEnv]?.trim();
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  }
  if (directEnv) {
    return process.env[directEnv]?.trim() || '';
  }
  return '';
}
