/** Format Slack user_id (apps natives incluses). */
export const SLACK_USER_ID_RE = /^U[A-Z0-9]+$/i;

export function parseSlackNativeAgentUserIds(
  raw: string | undefined,
  options: { requireNonEmpty: boolean },
): ReadonlySet<string> {
  const value = raw?.trim() ?? '';
  if (!value) {
    if (options.requireNonEmpty) {
      throw new Error('missing_required_env:SLACK_NATIVE_AGENT_USER_IDS');
    }
    return new Set();
  }

  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 && options.requireNonEmpty) {
    throw new Error('missing_required_env:SLACK_NATIVE_AGENT_USER_IDS');
  }

  const ids = new Set<string>();
  for (const part of parts) {
    if (!SLACK_USER_ID_RE.test(part)) {
      throw new Error(`invalid_slack_native_agent_user_id:${part}`);
    }
    ids.add(part.toUpperCase());
  }
  return ids;
}

/** Extrait les user_id des tokens Slack `<@U…>` ou `<@U…|label>` — jamais le label seul. */
export function extractSlackMentionUserIds(text: string): string[] {
  const ids: string[] = [];
  const re = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    ids.push(match[1]!.toUpperCase());
  }
  return ids;
}

export function messageMentionsNativeAgent(
  text: string,
  nativeAgentUserIds: ReadonlySet<string>,
): boolean {
  if (nativeAgentUserIds.size === 0) {
    return false;
  }
  for (const id of extractSlackMentionUserIds(text)) {
    if (nativeAgentUserIds.has(id)) {
      return true;
    }
  }
  return false;
}
