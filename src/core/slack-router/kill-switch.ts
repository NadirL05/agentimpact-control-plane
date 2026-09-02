import { accessSync, constants } from 'node:fs';

/** Kill switch fichier : présence du fichier = Grok désactivé immédiatement. */
export function isGrokKillSwitchActive(killSwitchPath: string): boolean {
  try {
    accessSync(killSwitchPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
