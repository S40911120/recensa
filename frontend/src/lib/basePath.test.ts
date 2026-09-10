import { describe, expect, test } from 'vitest';
import { joinBasePath } from './basePath';

describe('joinBasePath', () => {
  test('keeps API and websocket URLs below the configured reverse-proxy path', () => {
    expect(joinBasePath('/claude/review-jsonl/', '/api/sessions')).toBe(
      '/claude/review-jsonl/api/sessions'
    );
    expect(joinBasePath('/claude/review-jsonl/', '/ws')).toBe('/claude/review-jsonl/ws');
  });

  test('works with the root path used by local development', () => {
    expect(joinBasePath('/', '/api/sessions')).toBe('/api/sessions');
  });
});
