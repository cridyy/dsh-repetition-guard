// Repair only the informational event emitted by guard 0.1.0. No history cleanup.
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { zstdDecompressSync, zstdCompressSync, constants } from 'node:zlib';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { Session } from '@deepseek-ai/dsh-session';

const EVENT = 'repetition-guard/detected';
const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

export function decodeFrames(bytes) {
  const frames = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length || bytes.readUInt32LE(offset) !== 0xfd2fb528) throw new Error(`Invalid ZSTD frame at ${offset}`);
    // Node decodes one frame; bytesWritten is the exact consumed input, so a
    // magic-looking byte sequence inside compressed data is never a boundary.
    const { buffer, engine } = zstdDecompressSync(bytes.subarray(offset), { info: true });
    const consumed = engine.bytesWritten;
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > bytes.length - offset) throw new Error('Invalid ZSTD input cursor');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (!text.endsWith('\n')) throw new Error('Incomplete JSONL frame; refusing to discard its tail');
    frames.push({ bytes: bytes.subarray(offset, offset + consumed), text });
    offset += consumed;
  }
  if (!frames.length) throw new Error('Empty log');
  return frames;
}

export function restoreFrames(frames) {
  const rows = frames.flatMap(frame => frame.text.trimEnd().split('\n').map(line => JSON.parse(line)));
  const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' });
  for (const row of rows.slice(1)) restore.decodeRow(row);
  const artifact = restore.finish();
  validateStoredEvents(artifact.header, artifact.events);
  Session.create(artifact.header.id, artifact.events, artifact.header, artifact.inheritedEventCount);
  return artifact;
}

export function planRepair(original) {
  const frames = decodeFrames(original), seqs = [];
  const updated = frames.map(frame => {
    let changed = false;
    const lines = frame.text.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const row = JSON.parse(lines[i]);
      if (row.type !== EVENT || row.ignorable === true) continue;
      if (Object.hasOwn(row, 'ignorable') || Object.hasOwn(row, 'surfaceOp') || Object.hasOwn(row, 'sourceEventSeqs')) {
        throw new Error(`Unexpected diagnostic envelope at seq ${row.seq}; refusing to reinterpret it`);
      }
      // Keep the rest of the original JSON text byte-for-byte, including data.
      lines[i] = lines[i].replace(/^(\s*)\{/, '$1{"ignorable":true,');
      seqs.push(row.seq);
      changed = true;
    }
    if (!changed) return frame;
    const text = lines.join('\n');
    return { text, bytes: zstdCompressSync(Buffer.from(text), checksum) };
  });
  const bytes = Buffer.concat(updated.map(frame => frame.bytes));
  const artifact = restoreFrames(decodeFrames(bytes));
  return { bytes, seqs, artifact, frames: frames.length };
}

// Match the installed DSH Windows cross-process lease, including its path hash.
// Keeping it for the entire read/backup/replace excludes live session writers.
function acquireLease(path) {
  if (process.platform !== 'win32') throw new Error('Applying this repair is supported on Windows only');
  const require = createRequire(import.meta.url);
  const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'));
  const kernel = hostRequire('koffi').load('kernel32.dll');
  const create = kernel.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']);
  const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']);
  const release = kernel.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']);
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
  const key = resolve(join(dirname(path), 'session.lock')).toLowerCase();
  const name = `Local\\dsh-session-lock-${createHash('sha256').update(key).digest('hex')}`;
  const handle = create(null, 1, 1, name);
  if (!handle) throw new Error('Cannot acquire session write lease');
  if (wait(handle, 0) !== 0) {
    close(handle);
    throw new Error('Session is in use; close that session or stop dsh web before applying repair');
  }
  return () => { try { release(handle, 1, null); } finally { close(handle); } };
}

function durableWrite(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

export function repairFile(inputPath, { apply = false } = {}) {
  const path = resolve(inputPath);
  if (!/^session\.v(?:3|4)\.jsonl\.zstd$/u.test(basename(path))) throw new Error('Expected an explicit session.v3.jsonl.zstd or session.v4.jsonl.zstd path');
  const unlock = apply ? acquireLease(path) : () => {};
  try {
    const original = readFileSync(path);
    const plan = planRepair(original);
    const result = { session: plan.artifact.header.id, events: plan.artifact.events.length, frames: plan.frames, repairedSeqs: plan.seqs, applied: false };
    if (!apply || !plan.seqs.length) return result;
    const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const backup = `${path}.guard-backup-${suffix}`;
    const staging = `${path}.guard-staging-${suffix}`;
    durableWrite(backup, original);
    try {
      durableWrite(staging, plan.bytes);
      if (!readFileSync(backup).equals(original)) throw new Error('Backup verification failed');
      if (!readFileSync(path).equals(original)) throw new Error('Log changed during repair; original left untouched');
      restoreFrames(decodeFrames(readFileSync(staging)));
      renameSync(staging, path);
    } finally {
      try { unlinkSync(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { ...result, applied: true, backup };
  } finally { unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [path, flag] = process.argv.slice(2);
    if (!path || (flag && flag !== '--apply') || process.argv.length > 4) throw new Error('Usage: node tools/repair-diagnostic-event.mjs <session.v3.jsonl.zstd|session.v4.jsonl.zstd> [--apply]');
    console.log(JSON.stringify(repairFile(path, { apply: flag === '--apply' }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
