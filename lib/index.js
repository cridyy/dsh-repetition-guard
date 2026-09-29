import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { isAgentLoopRequest, LlmError, createSystemMessage } from '@deepseek-ai/dsh-llm';
import { DEFAULTS, resolveConfig } from './config.js';
import { guardStream, isGuardFailure, LIMIT_CODE } from './stream.js';

export const name = 'repetition-guard';
export const inject = ['llm', 'agents'];
export const Config = z.object(Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [
  key, (typeof value === 'boolean' ? z.boolean() : z.number()).default(value),
])));

function delay(ms, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = ok => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(ok); };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  if (!config.enabled) return;
  const states = new WeakMap();
  const lifetime = new AbortController();
  const waits = new Set();
  const disposers = [];

  function stateFor(agent, turn, step) {
    let state = states.get(agent);
    if (!state || state.turn !== turn || state.step !== step) {
      state = { turn, step, failures: 0, retries: 0, retryId: randomUUID(), quarantined: false, pending: [] };
      states.set(agent, state);
    }
    return state;
  }
  function note(message) { ctx.logger.info(`repetition-guard: ${message}`); }
  note(`已启用流式复读隔离，每步最多自动重试 ${config.maxRetries} 次。`);

  disposers.push(ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const previous = states.get(agent);
    if (previous) {
      await Promise.all(previous.pending);
      if (previous.quarantineError) throw previous.quarantineError;
    }
    const state = stateFor(agent, turn, step);
    signal.throwIfAborted();
    // A second boundary check caps actual provider calls even if another recovery
    // plugin with an "always" policy tries to override our terminal decision.
    if (state.failures > config.maxRetries) {
      throw new LlmError(`复读守卫已用完 ${config.maxRetries} 次自动重试；请调整任务或模型后再继续。`, LIMIT_CODE);
    }
    state.quarantined = false;
    return next();
  }, { prepend: true }));

  disposers.push(ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options) || !options.sessionId || lifetime.signal.aborted) return next();
    const agent = ctx.agents.get(options.sessionId);
    const state = agent && states.get(agent);
    if (!state) return next();
    return guardStream(next(), {
      config, signal: options.signal,
      onFailure(failure, finding) {
        state.failures++;
        state.quarantined = true;
        note(`${agent.id} t${state.turn}s${state.step}: ${failure.message}`);
        // DSH 0.1.5-rc.2 append() drops ignorable, so custom durable events
        // cannot be safely reopened. Keep metrics in the runtime logger only;
        // assistant/attempt and llm/retry already persist the failure itself.
        note(`detected ${JSON.stringify({
          turn: state.turn, step: state.step, code: failure.code,
          finding, failures: state.failures, maxRetries: config.maxRetries,
        })}`);
      },
    });
  }, { prepend: true }));

  disposers.push(ctx.on('agent/request-error', (payload, next) => {
    if (!isGuardFailure(payload.failure.code)) return next();
    const operation = (async () => {
      const { agent, turn, step, provider, failure, signal } = payload;
      const state = stateFor(agent, turn, step);
      const fused = AbortSignal.any([signal, lifetime.signal]);
      if (fused.aborted) return;
      if (state.retries >= config.maxRetries) {
        note(`${agent.id}: 自动重试次数已用尽，停止本轮。`);
        return; // Never delegate a guard failure to an unlimited retry policy.
      }
      const retry = ++state.retries;
      const policyKey = `repetition-guard/v1/${config.maxRetries}`;
      agent.session.append('llm/retry', {
        retryId: state.retryId, turn, step, provider, mode: 'normal', policyKey,
        retry, maxRetries: config.maxRetries, delayMs: config.retryDelayMs, failure,
      });
      note(`${agent.id}: 将从有效上下文重试 ${retry}/${config.maxRetries}。`);
      if (!await delay(config.retryDelayMs, fused)) return;
      agent.session.append('llm/retry-started', { retryId: state.retryId, turn, step, retry });
      return { kind: 'retry' };
    })();
    waits.add(operation);
    operation.then(() => waits.delete(operation), () => waits.delete(operation));
    return operation;
  }, { prepend: true }));

  // Narrow race recovery: the user can stop while a detected upstream is closing.
  // Core then commits interruptedBlocks(). Shadow ONLY that newly produced message;
  // never scan, rewrite, or clean an existing session's older history.
  disposers.push(ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message' || !event.data.interrupted || event.surfaceOp !== 'append') return;
    const agent = ctx.agents.get(session.id);
    const state = agent && states.get(agent);
    if (!state?.quarantined || state.turn !== event.data.turn || state.step !== event.data.step) return;
    if (event.data.message.content.some(block => block.type === 'tool-call')) return;
    // Session forbids reentrant append while publishing an event. Defer until
    // that transaction closes, and block the next request until this settles.
    const task = Promise.resolve().then(() => {
      session.append('system/message', {
        message: createSystemMessage('上一次生成因重复而中止，其未完成内容已隔离；该次尝试未执行工具。', name),
      }, {
        surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
        sourceEventSeqs: [event.seq],
      });
      note(`${session.id}: 已隔离中止竞态产生的异常消息 ${event.seq}。`);
    }).catch(error => {
      state.quarantineError = new LlmError('异常生成的隔离未完成，已阻止后续请求。', 'DSH_QUARANTINE_FAILED', { cause: error });
      ctx.logger.error('repetition-guard: %o', error);
    });
    state.pending.push(task);
    waits.add(task);
    task.then(() => waits.delete(task));
  }));

  ctx.effect(() => async () => {
    for (const dispose of disposers) dispose();
    lifetime.abort(new Error('复读守卫已卸载'));
    await Promise.allSettled([...waits]);
  }, 'repetition-guard: dispose');
}
