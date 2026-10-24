import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinearApiError, LinearClient } from './linear-client.js';

afterEach(() => vi.unstubAllGlobals());

describe('Linear issue lookup', () => {
  it('treats Linear’s missing-issue INPUT_ERROR as an absent issue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message: 'Could not find referenced Issue.', extensions: { code: 'INPUT_ERROR' } }],
    }), { status: 400 })));

    expect(await new LinearClient('test').getIssue('00000000-0000-4000-8000-000000000001')).toBeNull();
  });

  it('preserves other INPUT_ERROR responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message: 'Invalid issue ID.', extensions: { code: 'INPUT_ERROR' } }],
    }), { status: 400 })));

    await expect(new LinearClient('test').getIssue('bad')).rejects.toMatchObject({
      code: 'graphql_INPUT_ERROR', detail: 'Invalid issue ID.',
    } satisfies Partial<LinearApiError>);
  });
});
