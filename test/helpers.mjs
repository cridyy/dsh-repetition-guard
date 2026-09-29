import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import Agents from '@deepseek-ai/dsh-agent';
import Sessions from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
const plugin = await import(process.env.DSH_GUARD_TEST_ENTRY ?? '../lib/index.js');

export const englishLoop = 'Writing.  OK.  Let me write.  Go.  Writing.  Now.  Let me write.\n';
export const chineseLoop = '好。执行。好。（输出工具调用）现在。好。\n';
export async function* reasoning(value, { size = 37, finish = true } = {}) {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' };
  for (let i = 0; i < value.length; i += size) yield { type: 'reasoning-delta', index: 0, text: value.slice(i, i + size) };
  if (finish) {
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: value } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export async function* answer(value = '任务完成。') {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: value };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
export const collect = async source => { const out = []; for await (const x of source) out.push(x); return out; };

export async function harness(t, generate, config = {}) {
  const ctx = new Context();
  const logs = [];
  ctx.provide('logger', { info: (...x) => logs.push(x), warn: (...x) => logs.push(x), error: (...x) => logs.push(x), debug() {} });
  for (const Service of [LlmRuntime, Agents, Sessions, Projections, SystemPrompt, Tools]) await ctx.plugin(Service, {});
  const requests = [];
  class Adapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options);
      yield* generate(options, requests.length);
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter());
  await ctx.plugin(AgentLoop, { agents: [] });
  const guard = await ctx.plugin(plugin, { retryDelayMs: 0, ...config });
  t.after(() => ctx.fiber.dispose());
  const handle = await ctx.agents.create({ sessionId: `test-${randomUUID()}`, agentOptions: { provider: 'test', model: 'test-model' } });
  const agent = handle.agent ?? ctx.agents.get(handle.id);
  return {
    ctx, agent, handle, requests, logs, guard,
    async run(text = '继续当前任务') {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
      await agent.whenIdle();
      return agent.session.snapshotEvents();
    },
  };
}
