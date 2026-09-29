import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [mode, profileDir, installedDir, runtimeDir, composedFile] = process.argv.slice(2);
if (!['install', 'rollback'].includes(mode) || !profileDir) throw new Error('参数错误');
const patchPath = join(profileDir, 'cordis.patch.yml');
const original = readFileSync(patchPath, 'utf8');
const begin = '# BEGIN dsh-repetition-guard (managed)';
const end = '# END dsh-repetition-guard (managed)';
const section = /\r?\n?# BEGIN dsh-repetition-guard \(managed\)[\s\S]*?# END dsh-repetition-guard \(managed\)\r?\n?/g;
if ((original.includes(begin) || original.includes(end)) && !original.match(section)) throw new Error('托管区块不完整，拒绝修改配置');
let clean = original.replace(section, '\n');
if (mode === 'rollback') {
  if (clean === original) { console.log('没有需要回滚的托管配置。'); process.exit(0); }
  if (!clean.replace(/^\s*#.*$/gm, '').trim()) clean += '[]\n';
  copyFileSync(patchPath, patchPath + '.before-repetition-rollback');
  writeFileSync(patchPath, clean);
  console.log('已移除复读守卫接入及其冲突覆盖；保留插件文件和原始会话。');
  process.exit(0);
}
const require = createRequire(join(runtimeDir, 'package.json'));
const yaml = require('js-yaml');
const Js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ __guardJsExpression: value }) });
const schema = yaml.DEFAULT_SCHEMA.extend([Js]);
let composed;
try { composed = yaml.load(readFileSync(composedFile, 'utf8'), { schema }); }
catch { throw new Error('无法解析 dsh 合成配置；配置尚未修改'); }
const entries = [];
function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.id && value.name) entries.push(value);
  if (Array.isArray(value)) for (const child of value) walk(child);
  else if (value.group && Array.isArray(value.config)) walk(value.config);
}
walk(composed);
const patches = [];
const thinking = entries.find(e => e.name === '@argszero/cordis-plugin-thinking-loop-guard');
if (thinking) patches.push({ id: thinking.id, disabled: true });
const toolGuard = entries.find(e => e.name === '@goodandready/dsh-agent-loop-guard');
if (toolGuard) {
  if (JSON.stringify(toolGuard.config).includes('__guardJsExpression')) throw new Error('已有工具守卫使用动态配置，无法安全合并');
  patches.push({ id: toolGuard.id, config: { ...toolGuard.config, assistantOutputGuard: false } });
}
patches.push({ insert: [{
  id: 'repetition-guard', name: join(installedDir, 'lib', 'index.js').replaceAll('\\', '/'),
  config: { enabled: true, maxRetries: 1, retryDelayMs: 1000 },
}] });
// Do not serialize the user's existing YAML, comments, credentials, or !!js.
// Only append our own region; a rollback removes precisely this region.
if (clean.replace(/^\s*#.*$/gm, '').trim() === '[]') clean = clean.replace(/^\s*\[\]\s*$/m, '');
const updated = clean.trimEnd() + '\n\n' + begin + '\n' + yaml.dump(patches, { lineWidth: -1, noRefs: true }) + end + '\n';
try { if (!Array.isArray(yaml.load(updated, { schema }))) throw new Error(); }
catch { throw new Error('接入配置校验失败；配置尚未修改'); }
copyFileSync(patchPath, patchPath + '.before-repetition-' + new Date().toISOString().replace(/[:.]/g, '-'));
writeFileSync(patchPath, updated);
console.log(JSON.stringify({ installed: 'repetition-guard', profile: profileDir, replacesThinkingGuard: !!thinking, preservesToolGuard: !!toolGuard }));
