import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const runtimeAnchor = dirname(require.resolve('@deepseek-ai/dsh-llm/package.json'));
const script = fileURLToPath(new URL('../tools/profile-patch.mjs', import.meta.url));
function temporaryProfile(t) {
  const prefix = join(realpathSync(tmpdir()), 'dsh-guard-patch-test-');
  const folder = mkdtempSync(prefix);
  t.after(() => {
    const absolute = realpathSync(folder);
    assert.ok(absolute.startsWith(prefix), 'only remove the exact test-owned temporary directory');
    rmSync(absolute, { recursive: true });
  });
  return folder;
}

test('profile install is idempotent and rollback preserves unrelated edits', t => {
  const folder = temporaryProfile(t);
  const original = '# Existing user comment\n- id: example\n  config:\n    value: !!js existingExpression()\n';
  writeFileSync(join(folder, 'cordis.patch.yml'), original);
  const composed = join(folder, 'composed.json');
  writeFileSync(composed, JSON.stringify([
    { id: 'thinking-loop-guard', name: '@argszero/cordis-plugin-thinking-loop-guard' },
    { id: 'tools-guard', name: '@goodandready/dsh-agent-loop-guard', config: { maxToolAttemptsPerTurn: 91 } },
  ]));
  const install = () => execFileSync(process.execPath, [script, 'install', folder, join(folder, 'plugin'), runtimeAnchor, composed]);
  install(); install();
  const installed = readFileSync(join(folder, 'cordis.patch.yml'), 'utf8');
  assert.ok(installed.startsWith(original));
  assert.equal(installed.match(/id: repetition-guard/g).length, 1);
  assert.match(installed, /maxToolAttemptsPerTurn: 91/);
  assert.match(installed, /assistantOutputGuard: false/);
  const extra = '\n- id: later-user-edit\n  disabled: true\n';
  writeFileSync(join(folder, 'cordis.patch.yml'), installed + extra);
  execFileSync(process.execPath, [script, 'rollback', folder]);
  const rolled = readFileSync(join(folder, 'cordis.patch.yml'), 'utf8');
  assert.ok(rolled.startsWith(original));
  assert.ok(rolled.includes(extra.trim()));
  assert.ok(!rolled.includes('repetition-guard'));
});

test('malformed managed markers cause no config mutation', t => {
  const folder = temporaryProfile(t);
  const text = '# BEGIN dsh-repetition-guard (managed)\n';
  writeFileSync(join(folder, 'cordis.patch.yml'), text);
  assert.throws(() => execFileSync(process.execPath, [script, 'rollback', folder], { stdio: 'pipe' }));
  assert.equal(readFileSync(join(folder, 'cordis.patch.yml'), 'utf8'), text);
});
