import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { guardStream, REPETITION_CODE } from '../lib/stream.js';
import { collect, englishLoop } from './helpers.mjs';

test('real pi-ai adapter closes SDK consumer and aborts only its own upstream signal', async () => {
  const caller = new AbortController();
  let upstreamSignal, sdkClosed = false;
  const model = { id: 'mock', provider: 'test', api: 'openai-responses', input: ['text'], contextWindow: 262144 };
  const profile = { provider: 'test', modelErrors: new Map(), streamIdleTimeoutMs: 10000 };
  const profiles = new Map([['test', profile]]);
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'local-test-only' });
  const snapshot = {
    profiles,
    models: {
      getModel: () => model,
      streamSimple(_model, _context, options) {
        upstreamSignal = options.signal;
        return (async function* () {
          try {
            yield { type: 'thinking_start', contentIndex: 0 };
            for (let i = 0; i < 500; i++) yield { type: 'thinking_delta', contentIndex: 0, delta: englishLoop };
          } finally { sdkClosed = true; }
        })();
      },
    },
  };
  const source = adapter.streamWithSnapshot({ provider: 'test', model: 'mock', messages: [], signal: caller.signal }, snapshot);
  const chunks = await collect(guardStream(source, { signal: caller.signal }));
  assert.equal(chunks.at(-1).reason.failure.code, REPETITION_CODE);
  assert.equal(sdkClosed, true);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(caller.signal.aborted, false);
});
