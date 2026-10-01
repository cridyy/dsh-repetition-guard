import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import Sessions, { Session } from '@deepseek-ai/dsh-session';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { harness, reasoning, englishLoop, answer } from './helpers.mjs';
import { decodeFrames, planRepair, repairFile } from '../tools/repair-diagnostic-event.mjs';

function temporaryRoot(t) {
  const prefix = join(realpathSync(tmpdir()), 'dsh-guard-persistence-test-');
  const root = mkdtempSync(prefix);
  t.after(() => {
    assert.ok(realpathSync(root).startsWith(prefix));
    rmSync(root, { recursive: true });
  });
  return root;
}

async function backend(root) {
  const ctx = new Context();
  ctx.provide('logger', { info() {}, warn() {}, error() {}, debug() {} });
  await ctx.plugin(Sessions, {});
  await ctx.plugin(Persistence, { root });
  return ctx;
}

test('guard failure and retry survive durable reload without the guard plugin installed', async t => {
  const root = temporaryRoot(t);
  const h = await harness(t, (_options, attempt) => attempt === 1 ? reasoning(englishLoop.repeat(500)) : answer());
  const events = await h.run();
  const header = h.agent.session.header;
  const writer = await backend(root);
  try {
    const handle = await writer.sessionPersistence.create(header);
    await handle.append(events);
    await handle.close();
  } finally { await writer.fiber.dispose(); }
  // A new backend goes through the actual disk reader and vocabulary check.
  const reader = await backend(root);
  try {
    const handle = await reader.sessionPersistence.open(header.id, 'read');
    const restored = (await handle.read()).events;
    assert.deepEqual(restored, events);
    assert.ok(restored.some(e => e.type === 'assistant/attempt'));
    assert.ok(restored.some(e => e.type === 'llm/retry'));
    const session = Session.create(header.id, restored, handle.header, handle.inheritedEventCount);
    assert.ok(!JSON.stringify(session.deriveMessages()).includes('Let me write'));
    assert.ok(JSON.stringify(session.deriveMessages()).includes('任务完成'));
    await handle.close();
  } finally { await reader.fiber.dispose(); }
});

const header = { version: 4, id: 'repair-test', createdAt: 1, isSeeded: false, delegationDepth: 0 };
const diagnostic = { type: 'repetition-guard/detected', seq: 0, time: 1, data: { finding: { chars: 4096 } } };
function fixture(events = [diagnostic]) {
  return Buffer.concat([sessionFormatCatalog.encodeCurrentHeader(header, 0), ...events]
    .map(row => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`))));
}

test('repair changes only diagnostic envelopes and preserves sequence, payload, and unrelated compressed frames', () => {
  const original = fixture([diagnostic, { type: 'session/title', seq: 1, time: 2, data: { title: '保留原文', messageSeqs: [], source: { kind: 'user' } } }]);
  const before = decodeFrames(original);
  const plan = planRepair(original);
  const after = decodeFrames(plan.bytes);
  assert.deepEqual(plan.seqs, [0]);
  assert.deepEqual(plan.artifact.events[0], { ignorable: true, ...diagnostic });
  assert.ok(before[0].bytes.equals(after[0].bytes));
  assert.ok(before[2].bytes.equals(after[2].bytes));
  assert.deepEqual(planRepair(plan.bytes).seqs, []);
  assert.ok(planRepair(plan.bytes).bytes.equals(plan.bytes));
});

test('repair refuses other unknown required events, malformed JSON, and truncated ZSTD', () => {
  assert.throws(() => planRepair(fixture([diagnostic, { type: 'other/required', seq: 1, time: 2, data: {} }])), /unknown.*(?:type|harness)/);
  assert.throws(() => planRepair(fixture().subarray(0, -1)));
  assert.throws(() => planRepair(zstdCompressSync(Buffer.from('{invalid}\n'))));
  assert.throws(() => planRepair(fixture([{ ...diagnostic, surfaceOp: 'append' }])), /Unexpected diagnostic envelope/);
});

test('repair dry run leaves original untouched; apply keeps exact backup and is idempotent', { skip: process.platform !== 'win32' }, t => {
  const root = temporaryRoot(t), path = join(root, 'session.v4.jsonl.zstd');
  const original = fixture();
  writeFileSync(path, original);
  assert.equal(repairFile(path).applied, false);
  assert.ok(readFileSync(path).equals(original));
  assert.equal(readdirSync(root).length, 1);
  const result = repairFile(path, { apply: true });
  assert.equal(result.applied, true);
  assert.ok(readFileSync(result.backup).equals(original));
  assert.equal(repairFile(path, { apply: true }).applied, false);
  assert.equal(readdirSync(root).length, 2);
});

test('repair respects the real DSH writer lease and repaired log reopens through the host', { skip: process.platform !== 'win32' }, async t => {
  const root = temporaryRoot(t), writer = await backend(root);
  let path;
  try {
    const handle = await writer.sessionPersistence.create(header);
    await handle.append([diagnostic]);
    await handle.flush();
    path = join(root, '_no-cwd', header.id, 'session.v4.jsonl.zstd');
    const original = readFileSync(path);
    assert.throws(() => repairFile(path, { apply: true }), /Session is in use/);
    assert.ok(readFileSync(path).equals(original));
    await handle.close();
  } finally { await writer.fiber.dispose(); }
  const brokenReader = await backend(root);
  try {
    await assert.rejects(() => brokenReader.sessionPersistence.open(header.id, 'read'), /unknown to this harness/);
  } finally { await brokenReader.fiber.dispose(); }
  assert.equal(repairFile(path, { apply: true }).applied, true);
  const reader = await backend(root);
  try {
    const handle = await reader.sessionPersistence.open(header.id, 'read');
    assert.deepEqual((await handle.read()).events, [{ ignorable: true, ...diagnostic }]);
    await handle.close();
  } finally { await reader.fiber.dispose(); }
});
