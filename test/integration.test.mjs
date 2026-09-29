import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, reasoning, answer, englishLoop } from './helpers.mjs';
import * as retries from '@deepseek-ai/dsh-llm-retry';
import { defineTool } from '@deepseek-ai/dsh-tools';

test('real DSH loop retries and never puts failed reasoning in next request', async t => {
  const h = await harness(t, (_options, attempt) => attempt === 1 ? reasoning(englishLoop.repeat(500)) : answer());
  const events = await h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 1);
  assert.equal(events.filter(e => e.type === 'assistant/message').length, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 1);
  assert.ok(!JSON.stringify(h.requests[1].messages).includes('Let me write'));
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
});
test('persistent repetition makes exactly two calls then fails visibly', async t => {
  const h = await harness(t, () => reasoning(englishLoop.repeat(500)));
  const events = await h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(events.filter(e => e.type === 'assistant/message').length, 0);
  assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 2);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'error');
});
test('normal tool calls and healthy replies do not retry', async t => {
  const h = await harness(t, () => answer());
  const events = await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 0);
});

test('zero retries means exactly one failed call', async t => {
  const h = await harness(t, () => reasoning(englishLoop.repeat(500)), { maxRetries: 0 });
  const events = await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 0);
});

test('a new user turn receives a fresh retry budget', async t => {
  const h = await harness(t, (_options, attempt) => attempt % 2 ? reasoning(englishLoop.repeat(500)) : answer());
  await h.run('第一轮');
  await h.run('第二轮');
  assert.equal(h.requests.length, 4);
  assert.ok(!JSON.stringify(h.requests.at(-1).messages).includes('Let me write'));
});

test('user stop during backoff cancels recovery', async t => {
  const h = await harness(t, () => reasoning(englishLoop.repeat(500)), { retryDelayMs: 1000 });
  h.ctx.on('session/event', (_session, event) => {
    if (event.type === 'llm/retry') queueMicrotask(() => h.agent.cancel({ kind: 'user' }));
  });
  const events = await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry-started').length, 0);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'aborted');
});

test('user stop while streaming does not retry or rewrite ordinary partial content', async t => {
  const h = await harness(t, async function* (options) {
    yield { type: 'text-delta', index: 0, text: '有效的部分回答' };
    h.agent.cancel({ kind: 'user' });
    options.signal.throwIfAborted();
  });
  const events = await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 0);
  assert.ok(JSON.stringify(h.agent.session.deriveMessages()).includes('有效的部分回答'));
});

test('stop during detected stream cleanup still isolates the newly interrupted message', async t => {
  let closeCount = 0;
  const h = await harness(t, async function* () {
    try { yield* reasoning(englishLoop.repeat(500)); }
    finally { closeCount++; h.agent.cancel({ kind: 'user' }); await Promise.resolve(); }
  });
  const events = await h.run();
  await Promise.resolve();
  assert.equal(closeCount, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'aborted');
  assert.ok(!JSON.stringify(h.agent.session.deriveMessages()).includes('Let me write'));
  assert.equal(h.agent.session.surface.replaceGeneration, 1);
});

test('empty completion uses the same bounded recovery', async t => {
  const h = await harness(t, (_options, attempt) => attempt === 1 ? reasoning('准备执行。') : answer());
  const events = await h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 1);
});

test('built-in retry cannot extend the guard budget', async t => {
  const h = await harness(t, () => reasoning(englishLoop.repeat(500)));
  await h.ctx.plugin(retries, {});
  const events = await h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 1);
});

test('an outer retry-everything plugin still cannot make a third provider call', async t => {
  const h = await harness(t, () => reasoning(englishLoop.repeat(500)));
  h.ctx.on('agent/request-error', async (_payload, next) => (await next()) ?? { kind: 'retry' }, { prepend: true });
  const events = await h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'error');
});

test('plugin disposal interrupts a pending retry', async t => {
  const h = await harness(t, () => reasoning(englishLoop.repeat(500)), { retryDelayMs: 1000 });
  h.ctx.on('session/event', (_session, event) => {
    if (event.type === 'llm/retry') queueMicrotask(() => h.guard.dispose());
  });
  await h.run();
  assert.equal(h.requests.length, 1);
});

test('a tool requested before a failed attempt is never executed; recovered tool executes once', async t => {
  let executions = 0;
  const h = await harness(t, async function* (_options, attempt) {
    if (attempt <= 2) {
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: `call-${attempt}`, name: 'record_once', arguments: '{}' } };
    }
    if (attempt === 1) yield* reasoning(englishLoop.repeat(500));
    else if (attempt === 2) yield { type: 'finish', reason: { kind: 'tool-calls' } };
    else yield* answer();
  });
  h.ctx.tools.register(defineTool({
    name: 'record_once', description: '测试工具，仅更新内存计数器', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { executions++; return 'ok'; },
  }));
  const events = await h.run();
  assert.equal(executions, 1);
  assert.equal(h.requests.length, 3);
  assert.equal(events.filter(e => e.type === 'tool/result').length, 1);
  assert.ok(!JSON.stringify(h.requests[1].messages).includes('call-1'));
  assert.equal(events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
});

test('non-agent LLM calls such as summaries do not inherit this retry guard', async t => {
  const h = await harness(t, () => reasoning(englishLoop.repeat(100)));
  const chunks = [];
  for await (const chunk of h.ctx.llm.stream({ provider: 'test', model: 'test-model', messages: [] })) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});
