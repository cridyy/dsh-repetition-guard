import { resolveConfig } from './config.js';

// Operates on characters, not SSE boundaries. Whitespace changes do not hide loops.
export class RepetitionDetector {
  constructor(config = {}, channel = 'reasoning') {
    this.config = resolveConfig(config);
    this.channel = channel;
    this.tail = '';
    this.chars = 0;
    this.nextCheck = channel === 'text' ? this.config.minTextChars : this.config.minReasoningChars;
    this.strikes = 0;
    this.hit = undefined;
  }

  push(text) {
    if (this.hit) return this.hit;
    // Process large deltas in bounded slices too: a single giant delta can loop.
    for (let offset = 0; offset < text.length; offset += 512) {
      const part = text.slice(offset, offset + 512).replace(/\s/gu, '');
      let index = 0;
      while (index < part.length) {
        const take = Math.min(part.length - index, Math.max(1, this.nextCheck - this.chars));
        this.tail = (this.tail + part.slice(index, index + take)).slice(-this.config.windowChars);
        this.chars += take;
        index += take;
        if (this.chars < this.nextCheck) continue;
        this.nextCheck = this.chars + this.config.checkEveryChars;
        const finding = this.inspect();
        this.strikes = finding ? this.strikes + 1 : 0;
        if (finding && this.strikes >= this.config.confirmations) {
          return this.hit = { channel: this.channel, chars: this.chars, ...finding };
        }
      }
    }
    return undefined;
  }

  inspect() {
    const c = this.config;
    const span = this.channel === 'text' ? Math.max(2048, c.minRepeatSpan) : c.minRepeatSpan;
    const maxPeriod = Math.min(c.maxPeriod, Math.floor(this.tail.length / c.minRepeats));
    for (let period = 1; period <= maxPeriod; period++) {
      const required = Math.max(span, period * c.minRepeats);
      if (required > this.tail.length) continue;
      let matches = 0;
      for (let i = this.tail.length - 1; i >= this.tail.length - required + period; i--) {
        if (this.tail[i] !== this.tail[i - period]) break;
        matches++;
      }
      if (matches >= required - period) return { kind: 'periodic', period, span: required };
    }
    // Variants such as "Writing / Let me write / Go" need not be strictly periodic.
    const sample = this.tail.slice(-Math.max(2048, span));
    if (sample.length < Math.max(2048, span)) return;
    const counts = new Map();
    for (let i = 0; i + c.gramChars <= sample.length; i++) {
      const gram = sample.slice(i, i + c.gramChars);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    const count = sample.length - c.gramChars + 1;
    let repeated = 0;
    for (const n of counts.values()) if (n >= c.minRepeats) repeated += n;
    const coverage = repeated / count;
    const threshold = this.channel === 'text' ? Math.max(0.97, c.repeatCoverage) : c.repeatCoverage;
    if (coverage >= threshold && counts.size / count <= 0.10) {
      return { kind: 'repeated-grams', coverage: +coverage.toFixed(4), span: sample.length };
    }
  }
}
