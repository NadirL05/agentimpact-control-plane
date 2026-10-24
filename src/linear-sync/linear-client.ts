export type LinearIssue = { id: string; identifier: string; url: string };

export class LinearApiError extends Error {
  constructor(public readonly code: string, public readonly detail = '') { super(code); }
}

type GraphqlResult<T> = { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> };

export class LinearClient {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = 'https://api.linear.app/graphql',
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new LinearApiError('transport_error');
    }
    if (response.status === 429) throw new LinearApiError('rate_limited');
    if (response.status >= 500) throw new LinearApiError('upstream_error');
    let body: GraphqlResult<T>;
    try { body = await response.json() as GraphqlResult<T>; }
    catch { throw new LinearApiError('invalid_response'); }
    if (body.errors?.length) {
      const code = body.errors[0]?.extensions?.code;
      throw new LinearApiError(code && /^[A-Z0-9_]{1,50}$/.test(code) ? `graphql_${code}` : 'graphql_error',
        body.errors[0]?.message ?? '');
    }
    if (!response.ok || !body.data) throw new LinearApiError(`http_${response.status}`);
    return body.data;
  }

  async getIssue(id: string): Promise<LinearIssue | null> {
    try {
      const data = await this.request<{ issue: LinearIssue | null }>(
        'query($id:String!){issue(id:$id){id identifier url}}', { id });
      return data.issue ?? null;
    } catch (error) {
      // Linear returns INPUT_ERROR for a valid UUID that does not identify an issue.
      if (error instanceof LinearApiError && error.code === 'graphql_INPUT_ERROR'
        && /^Could not find referenced Issue\.?$/i.test(error.detail)) return null;
      throw error;
    }
  }

  async createIssue(input: {
    id: string; teamId: string; projectId: string; stateId: string;
    title: string; description: string;
  }): Promise<LinearIssue> {
    const data = await this.request<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(
      'mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier url}}}',
      { input },
    );
    if (!data.issueCreate?.success || !data.issueCreate.issue) throw new LinearApiError('create_failed');
    return data.issueCreate.issue;
  }

  async updateIssue(id: string, input: { stateId: string; title: string; description: string }): Promise<LinearIssue> {
    const data = await this.request<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(
      'mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success issue{id identifier url}}}',
      { id, input },
    );
    if (!data.issueUpdate?.success || !data.issueUpdate.issue) throw new LinearApiError('update_failed');
    return data.issueUpdate.issue;
  }
}

export async function postSlackLink(botToken: string, channel: string, threadTs: string,
  issue: LinearIssue): Promise<void> {
  let response: Response;
  try {
    response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        channel, thread_ts: threadTs,
        text: `Suivi Linear : <${issue.url}|${issue.identifier}>`,
        client_msg_id: issue.id,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new LinearApiError('slack_transport_error'); }
  if (!response.ok) throw new LinearApiError(`slack_http_${response.status}`);
  const body = await response.json() as { ok?: boolean; error?: string };
  if (!body.ok) throw new LinearApiError(body.error && /^[a-z_]{1,50}$/.test(body.error)
    ? `slack_${body.error}` : 'slack_post_failed');
}
