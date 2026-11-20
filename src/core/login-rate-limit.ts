/**
 * Limite d'essais de connexion au tableau de bord (docs/SECURITY.md, étape 2).
 * En mémoire : suffisant pour un seul conteneur API ; un redémarrage remet les
 * compteurs à zéro, Cloudflare Access reste la première barrière.
 */
export interface LoginRateLimiter {
  /** Vrai si la clé a épuisé ses essais dans la fenêtre courante. */
  isBlocked(key: string, now?: number): boolean;
  /** Enregistre un échec ; renvoie vrai si la clé est désormais bloquée. */
  recordFailure(key: string, now?: number): boolean;
  /** Une connexion réussie efface les échecs de la clé. */
  reset(key: string): void;
}

export function createLoginRateLimiter(maxAttempts = 5, windowMs = 15 * 60 * 1000): LoginRateLimiter {
  const failures = new Map<string, number[]>();
  const recent = (key: string, now: number) => {
    const kept = (failures.get(key) ?? []).filter((t) => now - t < windowMs);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  };
  return {
    isBlocked(key, now = Date.now()) {
      return recent(key, now).length >= maxAttempts;
    },
    recordFailure(key, now = Date.now()) {
      const kept = recent(key, now);
      kept.push(now);
      failures.set(key, kept);
      if (failures.size > 10_000) {
        // Borne mémoire : on oublie la plus ancienne clé.
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
      return kept.length >= maxAttempts;
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

/** Clé client : IP transmise par Cloudflare (seul chemin public), sinon accès local. */
export function loginClientKey(headers: { get(name: string): string | null | undefined }): string {
  const ip = headers.get('cf-connecting-ip')?.trim();
  return ip && /^[0-9a-fA-F.:]{3,45}$/.test(ip) ? ip : 'direct';
}
