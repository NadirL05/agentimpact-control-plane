import type { ExecutionControl } from '../core/missions-v2/execution.js';
import { z } from 'zod';
import type { SlackMessageEvent } from '../core/slack-router/types.js';
import type { MissionStore } from '../core/missions-v2/store.js';
import { MissionError } from '../core/missions-v2/model.js';

// Explicit opt-in; ordinary routes remain V1. No external adapter is reachable here.
export async function handleV2Command(message: SlackMessageEvent, store: MissionStore,
  nadirUserId: string, accepted: () => void, execution?: ExecutionControl): Promise<string | null> {
  const text = (message.text ?? '').trim();
  const mission = /^MISSION V2 ([A-Z][A-Z0-9_-]{0,63})\s+([\s\S]+)$/.exec(text);
  const status = /^STATUS\s+(\S+)$/.exec(text);
  const control = /^(CANCEL|RETRY)\s+(\S+)$/.exec(text);
  const reservedControl = /^(CANCEL|RETRY)(?:\s|$)/.test(text);
  if (!mission && !status && !reservedControl && !text.startsWith('MISSION V2')) return null;
  if (message.user !== nadirUserId) return 'Commande V2 réservée à Nadir.';
  try {
    if (!await store.allowsThread(message.team_id,message.channel,message.thread_ts ?? message.ts))
      return reservedControl ? 'Commande V2 refusée dans ce fil.' : null;
    if (reservedControl) {
      if (!execution) return 'Contrôle d’exécution V2 désactivé.';
      if (!control || !z.string().uuid().safeParse(control[2]).success) return 'Format : CANCEL <mission_id> ou RETRY <mission_id>.';
      const mutation = {principal:`slack:${message.team_id}:${message.user}`,key:`${control[1].toLowerCase()}:${message.team_id}:${message.event_id}`};
      if (control[1] === 'CANCEL') {
        const result = await execution.cancel(control[2],mutation);
        accepted();
        return `Annulation enregistrée pour ${control[2]}. ${result.lifecycle_state === 'cancelled'
          ? 'Mission annulée.' : 'En attente de confirmation d’arrêt.'}`;
      }
      const attempt = await execution.retry(control[2],mutation);
      accepted();
      return `Nouvelle tentative ${attempt.attempt_number} enregistrée pour ${control[2]} — ${attempt.status}.`;
    }
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
      if (execution) {
        const rows = z.string().uuid().safeParse(status[1]).success
          ? [await execution.status(status[1])] : await execution.statusProject(status[1]);
        return rows.length ? rows.slice(0,20).map(formatExecutionStatus).join('\n\n') +
          (rows.length > 20 ? `\n${rows.length-20} autres missions : consulter STATUS <mission_id>.` : '')
          : 'Aucune mission V2 pour ce projet.';
      }
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


export function formatExecutionStatus(status: Awaited<ReturnType<ExecutionControl['status']>>): string {
  const attempt = status.active_attempt;
  const dependencyStates = status.dependencies.length
    ? status.dependencies.map((d: {depends_on_id:string;lifecycle_state:string}) => `${d.depends_on_id}:${d.lifecycle_state}`).join(', ')
    : 'aucune';
  const heartbeatAge = status.heartbeat_age == null ? 'inconnu' : `${Math.max(0,Math.floor(status.heartbeat_age))} s`;
  return [
    `${status.id} — ${status.project} : ${status.mission_state}`,
    `Phase : ${status.phase ?? 'aucune'} ; blocage : ${status.blocked_reason ?? 'aucun'}`,
    `Tentative : ${attempt ? `${attempt.attempt_number} (${attempt.id}, ${attempt.status})` : 'aucune'} ; worker : ${status.assigned_worker ?? 'aucun'}`,
    `Lease : ${status.lease_status} ; heartbeat : ${heartbeatAge}`,
    `Dépendances : ${dependencyStates}`,
    `Budget : ${status.budget_state} ; approval : ${status.approval_state}`,
  ].join('\n');
}
