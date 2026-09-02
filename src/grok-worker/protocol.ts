/** Protocole Unix socket routeur → worker Grok (v1). */

export const GROK_WORKER_PROTOCOL_VERSION = 1;
export const GROK_WORKER_MAX_REQUEST_BYTES = 64 * 1024;

export type GrokWorkerRequest = {
  v: typeof GROK_WORKER_PROTOCOL_VERSION;
  id: string;
  /** Texte utilisateur uniquement — aucune option agent arbitraire. */
  prompt: string;
};

export type GrokWorkerSuccess = {
  v: typeof GROK_WORKER_PROTOCOL_VERSION;
  id: string;
  ok: true;
  text: string;
  run_id?: string;
};

export type GrokWorkerFailure = {
  v: typeof GROK_WORKER_PROTOCOL_VERSION;
  id: string;
  ok: false;
  code: string;
  message: string;
};

export type GrokWorkerResponse = GrokWorkerSuccess | GrokWorkerFailure;

export function parseGrokWorkerRequest(raw: string): GrokWorkerRequest | null {
  try {
    const parsed = JSON.parse(raw) as GrokWorkerRequest;
    if (parsed.v !== GROK_WORKER_PROTOCOL_VERSION) return null;
    if (typeof parsed.id !== 'string' || !parsed.id) return null;
    if (typeof parsed.prompt !== 'string') return null;
    if (parsed.prompt.length > GROK_WORKER_MAX_REQUEST_BYTES) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function encodeGrokWorkerResponse(response: GrokWorkerResponse): string {
  return `${JSON.stringify(response)}\n`;
}
