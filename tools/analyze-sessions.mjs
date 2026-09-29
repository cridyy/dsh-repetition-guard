// Read-only replay. Produces metrics, never rewrites session files or sends requests.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { RepetitionDetector } from '../lib/detector.js';

const root = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', 'sessions');
const outputPath = process.argv[3];
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.zstd')) files.push(path);
  }
}
walk(root);
const coverage = { files: files.length, frames: 0, badFrames: 0, badLines: 0, rawMessages: 0, duplicateMessages: 0 };
const ids = new Set(), rows = [], errors = [];
for (const file of files) {
  const buffer = readFileSync(file), offsets = [], parts = [];
  // This format is a concatenation of independently compressed JSONL frames.
  // False magic or truncated frames are reported as errors, never silently skipped.
  for (let i = 0; i + 4 <= buffer.length; i++) if (buffer.readUInt32LE(i) === 0xfd2fb528) offsets.push(i);
  if (!offsets.length) { coverage.badFrames++; errors.push({ file, error: 'no ZSTD frame' }); }
  for (let i = 0; i < offsets.length; i++) {
    coverage.frames++;
    try { parts.push(zstdDecompressSync(buffer.subarray(offsets[i], offsets[i + 1] ?? buffer.length))); }
    catch (error) { coverage.badFrames++; errors.push({ file, offset: offsets[i], error: error.message }); }
  }
  const records = [];
  for (const line of Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)) {
    try { records.push(JSON.parse(line)); }
    catch { coverage.badLines++; }
  }
  const session = records.find(r => r.type === 'session')?.id;
  for (const event of records) {
    if (event.type !== 'assistant/message') continue;
    coverage.rawMessages++;
    const message = event.data.message;
    if (ids.has(message.id)) { coverage.duplicateMessages++; continue; }
    ids.add(message.id);
    const content = message.content ?? [];
    const reasoning = content.filter(b => b.type === 'reasoning').map(b => b.text).join('');
    const detectors = { reasoning: new RepetitionDetector(), text: new RepetitionDetector({}, 'text') };
    let hit;
    for (const record of event.data.stream ?? []) {
      const channel = record.type === 'reasoning-chunks' ? 'reasoning' : record.type === 'text-chunks' ? 'text' : null;
      if (channel) {
        for (const part of record.texts) { hit = detectors[channel].push(part); if (hit) break; }
      } else if (record.type === 'chunk' && record.chunk.type === 'block-end') {
        const block = record.chunk.block;
        if (detectors[block.type] && detectors[block.type].chars === 0) hit = detectors[block.type].push(block.text);
      }
      if (hit) break;
    }
    const lines = reasoning.split('\n').map(x => x.trim()).filter(Boolean);
    const frequencies = new Map();
    for (const c of reasoning) frequencies.set(c, (frequencies.get(c) ?? 0) + 1);
    const heuristic = reasoning.length >= 2000 && (Math.max(0, ...frequencies.values()) / reasoning.length >= 0.4 || new Set(lines).size / lines.length <= 0.2);
    rows.push({ session, messageId: message.id, seq: event.seq, turn: event.data.turn, step: event.data.step,
      reasoningChars: reasoning.length, onlyReasoning: content.length > 0 && content.every(b => b.type === 'reasoning'),
      interrupted: !!event.data.interrupted, oldHeuristic: heuristic, hit: hit ?? null });
  }
}
const hits = rows.filter(r => r.hit);
const summary = { coverage, uniqueMessages: rows.length, hits: hits.length,
  reasoningOnly: rows.filter(r => r.onlyReasoning).length,
  reasoningOnlyHits: hits.filter(r => r.onlyReasoning).length,
  oldHeuristicHits: rows.filter(r => r.oldHeuristic).length,
  oldHeuristicDetected: hits.filter(r => r.oldHeuristic).length,
  additionalHits: hits.filter(r => !r.oldHeuristic).length,
  detectionChars: hits.length ? { min: Math.min(...hits.map(r => r.hit.chars)), max: Math.max(...hits.map(r => r.hit.chars)) } : null,
};
console.log(JSON.stringify(summary, null, 2));
if (outputPath) writeFileSync(outputPath, JSON.stringify({ summary, rows, errors }, null, 2) + '\n');
if (coverage.badFrames || coverage.badLines) { console.error('日志解析不完整，不能将未检测到异常解释为正常。'); process.exitCode = 1; }
