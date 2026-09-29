import test from 'node:test';
import assert from 'node:assert/strict';
import { RepetitionDetector } from '../lib/detector.js';
import { resolveConfig } from '../lib/config.js';
const loops = [
  'Writing. OK. Let me write. Go. Writing. Now. Let me write.\n',
  '好。执行。好。（输出工具调用）现在。好。\n',
];
for (const [i, loop] of loops.entries()) {
  test(`detect loop ${i} independent of stream chunk sizes`, () => {
    const value = loop.repeat(500);
    const positions = [1, 37, 8192, value.length].map(size => {
      const detector = new RepetitionDetector();
      for (let n = 0; n < value.length; n += size) if (detector.push(value.slice(n, n + size))) break;
      assert.ok(detector.hit);
      assert.ok(detector.hit.chars <= 2304);
      return detector.hit.chars;
    });
    assert.equal(new Set(positions).size, 1);
  });
}
test('variant phrase order is detected without an exact period', () => {
  let seed = 17;
  const phrases = ['Writing.', 'Let me write.', 'Go.', 'Now.', 'OK.'];
  const value = Array.from({ length: 4000 }, () => { seed = (seed * 16807) % 2147483647; return phrases[seed % phrases.length]; }).join(' ');
  assert.ok(new RepetitionDetector().push(value));
});
test('varied prose, code, and a short repeated quotation remain healthy', () => {
  const value = Array.from({ length: 1000 }, (_, i) => `${i}: 检查第 ${i * 73} 条记录，其结果为 ${Math.sin(i)}；const v${i} = ${i * i};\n`).join('');
  assert.equal(new RepetitionDetector().push(value), undefined);
  assert.equal(new RepetitionDetector().push(loops[0].repeat(6)), undefined);
});
test('memory stays bounded and config refuses unbounded recovery', () => {
  const detector = new RepetitionDetector();
  for (let i = 0; i < 10000; i++) detector.push(`${i} item ${i * 713} ${Math.sin(i)}\n`);
  assert.ok(detector.tail.length <= 4096);
  assert.throws(() => resolveConfig({ maxRetries: 999 }));
  assert.throws(() => resolveConfig({ typo: true }));
});
