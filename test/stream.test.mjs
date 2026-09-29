import test from 'node:test';
import assert from 'node:assert/strict';
import { guardStream, EMPTY_CODE, REPETITION_CODE } from '../lib/stream.js';
import { collect, reasoning, answer, englishLoop } from './helpers.mjs';

test('healthy chunks are unchanged, including tool-call-only completion', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 't1', name: 'read', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  async function* source() { yield* chunks; }
  assert.deepEqual(await collect(guardStream(source())), chunks);
  assert.deepEqual(await collect(guardStream(answer())), await collect(answer()));
});
test('repetition closes upstream and emits one error with no replay metadata', async () => {
  let closed = false;
  async function* source() { try { yield* reasoning(englishLoop.repeat(500)); } finally { closed = true; } }
  const output = await collect(guardStream(source()));
  assert.equal(closed, true);
  assert.equal(output.at(-1).reason.failure.code, REPETITION_CODE);
  assert.equal(output.filter(c => c.type === 'finish').length, 1);
  assert.equal(output.at(-1).replayState, undefined);
});
test('short reasoning-only successful stop is isolated', async () => {
  const output = await collect(guardStream(reasoning('我需要分析一下。')));
  assert.equal(output.at(-1).reason.failure.code, EMPTY_CODE);
});
test('block-end-only and a giant text delta cannot bypass detection', async () => {
  for (const chunks of [
    [{ type: 'block-end', index: 0, block: { type: 'reasoning', text: englishLoop.repeat(500) } }],
    [{ type: 'text-delta', index: 0, text: englishLoop.repeat(500) }],
  ]) {
    async function* source() { yield* chunks; }
    const output = await collect(guardStream(source()));
    assert.equal(output.at(-1).reason.failure.code, REPETITION_CODE);
  }
});
test('caller cancellation is never converted into recoverable failure', async () => {
  const controller = new AbortController();
  controller.abort(new Error('用户停止'));
  let failures = 0;
  await assert.rejects(collect(guardStream(answer(), { signal: controller.signal, onFailure() { failures++; } })), /用户停止/);
  assert.equal(failures, 0);
});
test('transport failure passes through instead of being called empty output', async () => {
  const failure = { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: '断线' } } };
  async function* source() { yield failure; }
  assert.deepEqual(await collect(guardStream(source())), [failure]);
});
