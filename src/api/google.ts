/**
 * Acces Google (Calendar lecture, Drive lecture + deplacement).
 *
 * Le fichier de credentials est monte en lecture seule et n'est jamais
 * reecrit : il appartient a Hermes, un rafraichissement concurrent corromprait
 * son etat. Le token d'acces est donc rafraichi en memoire uniquement.
 */

import { readFile } from 'node:fs/promises';

const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH ?? '/secrets/google_token.json';
const TIMEOUT_MS = 15_000;

type StoredToken = {
  token?: string;
  refresh_token: string;
  client_id: string;
  client_secret: string;
  token_uri: string;
  scopes?: string[];
};

let cached: { accessToken: string; expiresAt: number } | null = null;
let stored: StoredToken | null = null;

async function loadStored(): Promise<StoredToken> {
  if (stored) return stored;
  const raw = await readFile(TOKEN_PATH, 'utf8');
  stored = JSON.parse(raw) as StoredToken;
  return stored;
}

export function googleConfigured(): boolean {
  return Boolean(TOKEN_PATH);
}

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const creds = await loadStored();

  const response = await fetch(creds.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new Error(`google_refresh_failed: ${body.error ?? response.status}`);
  }

  cached = {
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };

  return cached.accessToken;
}

async function googleFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await accessToken();

  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  attendees: number;
  hangoutLink: string | null;
};

/** Evenements du jour, calendrier principal. Lecture seule. */
export async function todayEvents(): Promise<CalendarEvent[]> {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '10',
  });

  const response = await googleFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
  );

  if (!response.ok) throw new Error(`calendar_http_${response.status}`);

  const body = (await response.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      attendees?: unknown[];
      hangoutLink?: string;
    }>;
  };

  return (body.items ?? []).map((item) => ({
    id: item.id,
    summary: item.summary ?? '(sans titre)',
    start: item.start?.dateTime ?? item.start?.date ?? '',
    attendees: Array.isArray(item.attendees) ? item.attendees.length : 0,
    hangoutLink: item.hangoutLink ?? null,
  }));
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  parents: string[];
  webViewLink: string | null;
};

/** Recherche Drive. `query` suit la syntaxe Drive v3. */
export async function driveSearch(query: string, limit = 25): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: query,
    pageSize: String(Math.min(Math.max(limit, 1), 100)),
    fields: 'files(id,name,mimeType,modifiedTime,parents,webViewLink)',
    orderBy: 'modifiedTime desc',
  });

  const response = await googleFetch(`https://www.googleapis.com/drive/v3/files?${params}`);

  if (!response.ok) throw new Error(`drive_http_${response.status}`);

  const body = (await response.json()) as { files?: DriveFile[] };
  return body.files ?? [];
}

export async function driveGet(fileId: string): Promise<DriveFile> {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,modifiedTime,parents,webViewLink',
  });

  const response = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?${params}`,
  );

  if (!response.ok) throw new Error(`drive_http_${response.status}`);
  return (await response.json()) as DriveFile;
}

/**
 * Deplace un fichier. Reversible : on renvoie les parents d'origine, ce qui
 * permet un rollback exact. Aucune suppression n'est possible ici.
 */
export async function driveMove(
  fileId: string,
  addParent: string,
  removeParents: string[],
): Promise<{ id: string; previousParents: string[]; parents: string[] }> {
  const params = new URLSearchParams({
    addParents: addParent,
    removeParents: removeParents.join(','),
    fields: 'id,parents',
  });

  const response = await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?${params}`,
    { method: 'PATCH', body: '{}' },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`drive_move_http_${response.status}: ${detail.slice(0, 200)}`);
  }

  const body = (await response.json()) as { id: string; parents?: string[] };

  return {
    id: body.id,
    previousParents: removeParents,
    parents: body.parents ?? [],
  };
}

// --- Ajouts Gmail (semaine 1-2 phase Growth) : lecture des reponses ---
// aux campagnes de prospection. Lecture seule ; aucune fonction d'envoi
// n'est ajoutee ici volontairement (l'envoi passe par Brevo, pas Gmail).

export type GmailMessage = {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  bodyText: string;
  internalDate: string;
};

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function extractPlainText(payload: {
  mimeType?: string;
  body?: { data?: string };
  parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
}): string {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return decodeBase64Url(part.body.data);
    }
  }

  // Repli sur le premier data trouve, meme si HTML : mieux qu'un vide.
  const anyPart = payload.parts?.find((part) => part.body?.data);
  return anyPart?.body?.data ? decodeBase64Url(anyPart.body.data) : '';
}

/**
 * Messages recus depuis `sinceQuery` (syntaxe de recherche Gmail, ex.
 * "newer_than:1d in:inbox"). Ne consulte que l'inbox : jamais les brouillons
 * ni les envois.
 */
export async function fetchRecentReplies(query: string, limit = 20): Promise<GmailMessage[]> {
  const listParams = new URLSearchParams({ q: query, maxResults: String(limit) });

  const listResponse = await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams}`,
  );

  if (!listResponse.ok) throw new Error(`gmail_list_http_${listResponse.status}`);

  const listBody = (await listResponse.json()) as { messages?: Array<{ id: string }> };
  const ids = listBody.messages ?? [];

  const messages: GmailMessage[] = [];

  for (const { id } of ids) {
    const detailResponse = await googleFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    );
    if (!detailResponse.ok) continue;

    const detail = (await detailResponse.json()) as {
      id: string;
      snippet?: string;
      internalDate?: string;
      payload?: {
        headers?: Array<{ name: string; value: string }>;
        mimeType?: string;
        body?: { data?: string };
        parts?: Array<{ mimeType?: string; body?: { data?: string } }>;
      };
    };

    const headers = detail.payload?.headers ?? [];
    const from = headers.find((h) => h.name === 'From')?.value ?? '';
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '';

    messages.push({
      id: detail.id,
      from,
      subject,
      snippet: detail.snippet ?? '',
      bodyText: detail.payload ? extractPlainText(detail.payload) : '',
      internalDate: detail.internalDate ?? '',
    });
  }

  return messages;
}
