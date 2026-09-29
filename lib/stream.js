import { RepetitionDetector } from './detector.js';
import { resolveConfig } from './config.js';

export const REPETITION_CODE = 'DSH_REPETITION_GUARD';
export const EMPTY_CODE = 'DSH_NO_ACTIONABLE_OUTPUT';
export const LIMIT_CODE = 'DSH_REPETITION_RETRY_LIMIT';
export const isGuardFailure = code => code === REPETITION_CODE || code === EMPTY_CODE;

export async function* guardStream(source, options = {}) {
  const config = resolveConfig(options.config);
  const reasoning = new RepetitionDetector(config, 'reasoning');
  const text = new RepetitionDetector(config, 'text');
  const streamed = new Set();
  let hasText = false, hasTool = false, hasOther = false;
  const iterator = source[Symbol.asyncIterator]();
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await iterator.return?.(); // The host adapter aborts its own HTTP consumer here.
  }
  async function fail(code, finding) {
    const failure = {
      code,
      message: code === EMPTY_CODE
        ? '模型本次生成没有正文或工具调用，已隔离该失败尝试。'
        : `检测到 ${finding.channel} 持续复读（${finding.kind}，${finding.chars} 个非空白字符），已隔离该失败尝试。`,
    };
    // Mark before awaited cleanup, so cancellation during cleanup can be quarantined.
    options.onFailure?.(failure, finding);
    try { await close(); }
    catch (error) {
      // A failed teardown must not start another paid request while its state is unknown.
      throw new Error('复读已拦截，但关闭上游流失败；本次不自动重试', { cause: error });
    }
    options.signal?.throwIfAborted();
    return { type: 'finish', reason: { kind: 'error', failure } };
  }
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const item = await iterator.next();
      options.signal?.throwIfAborted();
      if (item.done) { closed = true; return; }
      const chunk = item.value;
      let finding;
      if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
        streamed.add(`${chunk.type}:${chunk.index}`);
        if (chunk.type === 'text-delta') {
          hasText ||= !!chunk.text.trim();
          if (config.guardText) finding = text.push(chunk.text);
        } else finding = reasoning.push(chunk.text);
      } else if (chunk.type === 'block-end') {
        const b = chunk.block;
        if (b.type === 'text') hasText ||= !!b.text.trim();
        else if (b.type === 'tool-call') hasTool = true;
        else if (b.type !== 'reasoning') hasOther = true;
        if ((b.type === 'reasoning' || (b.type === 'text' && config.guardText)) && !streamed.has(`${b.type}-delta:${chunk.index}`)) {
          finding = (b.type === 'reasoning' ? reasoning : text).push(b.text);
        }
      } else if (chunk.type === 'tool-call-delta') {
        hasTool ||= !!chunk.name;
      }
      if (finding) { yield await fail(REPETITION_CODE, finding); return; }
      if (chunk.type === 'finish') {
        if (config.rejectEmptyCompletion && ['stop', 'max-tokens'].includes(chunk.reason.kind) && !hasText && !hasTool && !hasOther) {
          yield await fail(EMPTY_CODE, { kind: 'empty-completion', channel: 'reasoning', chars: reasoning.chars });
        } else {
          await close();
          options.signal?.throwIfAborted();
          yield chunk;
        }
        return;
      }
      yield chunk;
    }
  } finally {
    await close();
  }
}
