import { afterEach, describe, expect, test, vi } from 'vitest';
import { uploadSession } from './api';

describe('uploadSession', () => {
  afterEach(() => vi.restoreAllMocks());

  test('posts the selected JSONL as a multipart file and returns the new session id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sessionId: 'uploaded-123', indexed: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const file = new File(['{"type":"user"}\n'], 'session.jsonl', { type: 'application/jsonl' });

    await expect(uploadSession(file)).resolves.toMatchObject({ sessionId: 'uploaded-123' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/upload');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const uploaded = (init?.body as FormData).get('file') as File;
    expect(uploaded.name).toBe(file.name);
    expect(uploaded.size).toBe(file.size);
  });
});
