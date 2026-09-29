export const DEFAULTS = Object.freeze({
  enabled: true,
  maxRetries: 1,
  retryDelayMs: 1000,
  minReasoningChars: 2048,
  minTextChars: 4096,
  windowChars: 4096,
  checkEveryChars: 128,
  minRepeatSpan: 1024,
  maxPeriod: 512,
  minRepeats: 4,
  gramChars: 6,
  repeatCoverage: 0.92,
  confirmations: 2,
  guardText: true,
  rejectEmptyCompletion: true,
});

export function resolveConfig(input = {}) {
  const config = { ...DEFAULTS, ...input };
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULTS)) throw new TypeError(`未知复读守卫配置：${key}`);
  }
  for (const key of ['enabled', 'guardText', 'rejectEmptyCompletion']) {
    if (typeof config[key] !== 'boolean') throw new TypeError(`${key} 必须为布尔值`);
  }
  for (const key of ['maxRetries', 'retryDelayMs', 'minReasoningChars', 'minTextChars',
    'windowChars', 'checkEveryChars', 'minRepeatSpan', 'maxPeriod', 'minRepeats',
    'gramChars', 'confirmations']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (key === 'maxRetries' || key === 'retryDelayMs' ? 0 : 1)) {
      throw new TypeError(`${key} 必须是有效整数`);
    }
  }
  if (config.maxRetries > 3) throw new RangeError('maxRetries 最多为 3，避免循环重试');
  if (config.retryDelayMs > 30000) throw new RangeError('retryDelayMs 最多为 30000');
  if (config.windowChars > 16384 || config.windowChars < config.minRepeatSpan) throw new RangeError('windowChars 必须覆盖 minRepeatSpan 且不超过 16384');
  if (config.minRepeatSpan < 256 || config.minRepeats < 3 || config.gramChars < 4 || config.gramChars > 64) throw new RangeError('重复检测阈值过于激进或无效');
  if (config.maxPeriod * config.minRepeats > config.windowChars) throw new RangeError('检测窗口无法容纳最大周期及重复次数');
  if (config.checkEveryChars > config.windowChars || config.confirmations > 16) throw new RangeError('检测步长或确认次数无效');
  if (!Number.isFinite(config.repeatCoverage) || config.repeatCoverage < 0.8 || config.repeatCoverage > 1) throw new RangeError('repeatCoverage 必须在 0.8–1 之间');
  return Object.freeze(config);
}
