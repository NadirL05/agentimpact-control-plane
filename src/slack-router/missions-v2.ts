import { z } from 'zod';
import type { SlackMessageEvent } from '../core/slack-router/types.js';
import type { MissionStore } from '../core/missions-v2/store.js';
import { MissionError } from '../core/missions-v2/model.js';

// Explicit opt-in; ordinary routes remain V1. No external adapter is reachable here.
export async function handleV2Command(message: SlackMessageEvent, store: MissionStore,
  nadirUserId: string, accepted: () => void): Promise<string | null> {
  const text = (message.text ?? '').trim();
  const mission = /^MISSION V2 ([A-Z][A-Z0-9_-]{0,63})\s+([\s\S]+)$/.exec(text);
  const status = /^STATUS\s+(\S+)$/.exec(text);
  if (!mission && !status && !text.startsWith('MISSION V2')) return null;
  if (message.user !== nadirUserId) return 'Commande V2 réservée à Nadir.';
  try {
    if (!await store.allowsThread(message.team_id,message.channel,message.thread_ts ?? message.ts)) return null;
    if (mission) {
      const m = await store.admit({project:mission[1],title:mission[2].slice(0,200),objective:mission[2],
        source_type:'slack',source_id:`${message.team_id}:${message.event_id}`},
      {principal:`slack:${message.team_id}:${message.user}`,key:`slack:${message.team_id}:${message.event_id}`},
      {team_id:message.team_id,event_id:message.event_id,channel:message.channel,user:message.user!,
        thread_ts:message.thread_ts ?? message.ts,is_root:!message.thread_ts || message.thread_ts === message.ts});
      accepted();
      return `Mission ${m.id} enregistrée — ${m.project} : ${m.lifecycle_state}.`;
    }
    if (status) {
      const rows = z.string().uuid().safeParse(status[1]).success
        ? [await store.get(status[1])] : await store.status(status[1]);
      return rows.length ? rows.map(m => `${m.id} — ${m.project} : ${m.lifecycle_state} (v${m.state_version})`).join('\n')
        : 'Aucune mission V2 pour ce projet.';
    }
    return 'Format : MISSION V2 <PROJET> <objectif>.';
  } catch (error) {
    if (error instanceof MissionError && error.status !== 503) return `Commande refusée : ${error.code}.`;
    throw new Error('v2_admission_unavailable');
  }
}
