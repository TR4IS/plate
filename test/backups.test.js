import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../server/http.js';

process.env.AI_RETRY_WAIT_MS = '0';
const { withBackups } = await import('../server/ai.js');
const busy = () => new HttpError(503, 'busy', { code: 'ai_busy' });

test('a busy model is retried, then a backup model answers', async () => {
  const seen = [];
  const out = await withBackups('gemini', 'gemini-flash-latest', async (m) => {
    seen.push(m);
    if (m === 'gemini-flash-latest') throw busy();
    return 'ok from ' + m;
  });
  assert.equal(out, 'ok from gemini-flash-lite-latest');
  assert.deepEqual(seen, ['gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest']);
});

test('other errors are not retried', async () => {
  let calls = 0;
  await assert.rejects(
    withBackups('gemini', 'gemini-flash-latest', async () => {
      calls++;
      throw new HttpError(502, 'bad key', { code: 'ai_auth' });
    }),
    /bad key/,
  );
  assert.equal(calls, 1);
});

test('when everything is busy the user gets the busy message', async () => {
  await assert.rejects(withBackups('gemini', 'gemini-flash-latest', async () => { throw busy(); }), /busy/);
});

test('a broken JSON answer is retried on the same model', async () => {
  let calls = 0;
  const out = await withBackups('groq', 'qwen/qwen3.8-27b', async () => {
    if (++calls < 3) throw new HttpError(502, 'broken', { code: 'ai_flaky' });
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('a per-minute limit is waited out on the same model', async () => {
  const seen = [];
  const out = await withBackups('groq', 'qwen/qwen3.8-27b', async (m) => {
    seen.push(m);
    if (seen.length < 3) throw new HttpError(503, 'slow down', { code: 'ai_busy', retryAfterMs: 10 });
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(seen.length, 3);
});
