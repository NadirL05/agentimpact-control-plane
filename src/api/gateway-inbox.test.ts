import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { mockConnect, mockQuery, mockRelease, mockPoolQuery } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockQuery: vi.fn(),
  mockRelease: vi.fn(),
  mockPoolQuery: vi.fn(),
}));

vi.mock('./db.js', () => ({
  pool: {
    connect: mockConnect,
    query: mockPoolQuery,
  },
}));

import gatewayInbox from './gateway-inbox.js';

const app = new Hono();
app.route('/', gatewayInbox);

describe('gateway-inbox claim isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue({
      query: mockQuery,
      release: mockRelease,
    });
  });

  it('claim hermes uniquement pour target=hermes', async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: 'id-1',
            prompt: 'hello',
            channel_id: 'C1',
            thread_ts: '1.0',
            user_id: 'U1',
            event_id: 'E1',
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await app.request('/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'hermes' }),
    });
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE target = $1'),
      ['hermes'],
    );
  });

  it('claim ana uniquement pour target=ana', async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({});

    const res = await app.request('/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'ana' }),
    });
    expect(res.status).toBe(204);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE target = $1'), ['ana']);
  });

  it('rejette target inconnu (grok)', async () => {
    const res = await app.request('/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'grok' }),
    });
    expect(res.status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('rejette target devin', async () => {
    const res = await app.request('/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'devin' }),
    });
    expect(res.status).toBe(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('claim atomique avec FOR UPDATE SKIP LOCKED', async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({});

    await app.request('/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'hermes' }),
    });
    expect(mockQuery.mock.calls[1][0]).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('complete ne modifie que les items en processing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    const res = await app.request('/id-1/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ok' }),
    });
    expect(res.status).toBe(200);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'processing'"),
      expect.any(Array),
    );
  });
});
