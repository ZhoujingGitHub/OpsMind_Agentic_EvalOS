export class BudgetExceededError extends Error {
  constructor(dimension, usage, limit) {
    super(`budget exceeded for ${dimension}: ${usage}/${limit}`);
    this.name = "BudgetExceededError";
    this.dimension = dimension;
    this.usage = usage;
    this.limit = limit;
  }
}

export class BudgetTracker {
  constructor(limits, usage = {}) {
    this.limits = { ...limits };
    this.usage = Object.fromEntries(Object.keys(limits).map((key) => [key, Number(usage[key] ?? 0)]));
    this.warned = new Set();
  }

  consume(delta) {
    const warnings = [];
    for (const [dimension, amount] of Object.entries(delta)) {
      if (!(dimension in this.limits)) throw new Error(`unknown budget dimension: ${dimension}`);
      const next = this.usage[dimension] + Math.max(0, Number(amount));
      const limit = this.limits[dimension];
      if (next >= limit) throw new BudgetExceededError(dimension, next, limit);
      this.usage[dimension] = next;
      const ratio = next / limit;
      if (ratio >= 0.8 && !this.warned.has(dimension)) {
        this.warned.add(dimension);
        warnings.push({ dimension, usage: next, limit, ratio });
      }
    }
    return warnings;
  }

  snapshot() {
    return {
      limits: { ...this.limits },
      usage: { ...this.usage },
      ratios: Object.fromEntries(Object.keys(this.limits).map((key) => [key, this.usage[key] / this.limits[key]])),
      warnings: [...this.warned],
    };
  }
}

