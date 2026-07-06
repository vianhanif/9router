import crypto from "node:crypto";

const MAX_LOG_ENTRIES = 100;

class StatsCollector {
  constructor() {
    this.logEntries = [];
    this.activeRequests = 0;
    this.activeRequestIds = new Set();
    this.providerUsage = {};
    this.startTime = Date.now();
    this.totalRequests = 0;
    this.errorCount = 0;
  }

  requestStart({ method, path, model, combo, msgs, tools } = {}) {
    this.activeRequests++;
    const id = crypto.randomUUID();
    this.activeRequestIds.add(id);
    const entry = {
      id,
      method,
      path,
      model,
      combo,
      msgs,
      tools,
      time: Date.now(),
      type: "start",
    };
    this.logEntries.unshift(entry);
    if (this.logEntries.length > MAX_LOG_ENTRIES) this.logEntries.pop();
    return id;
  }

  requestEnd({ id, status, duration, provider, model, tokensIn, tokensOut, cacheRead, reasoning, error } = {}) {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.activeRequestIds.delete(id);
    this.totalRequests++;
    if (status >= 400) this.errorCount++;

    const entry = this.logEntries.find((e) => e.id === id);
    if (entry) {
      entry.type = "end";
      entry.status = status;
      entry.duration = duration;
      entry.provider = provider;
      entry.model = model;
      entry.tokensIn = tokensIn;
      entry.tokensOut = tokensOut;
      entry.cacheRead = cacheRead;
      entry.reasoning = reasoning;
      entry.error = error;
    }

    if (provider && tokensIn != null) {
      if (!this.providerUsage[provider]) {
        this.providerUsage[provider] = { in: 0, out: 0, cacheRead: 0, reasoning: 0, requests: 0 };
      }
      const p = this.providerUsage[provider];
      p.in += tokensIn || 0;
      p.out += tokensOut || 0;
      p.cacheRead += cacheRead || 0;
      p.reasoning += reasoning || 0;
      p.requests++;
    }
  }

  requestError({ id, status, error } = {}) {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.activeRequestIds.delete(id);
    this.errorCount++;
    this.totalRequests++;

    const entry = this.logEntries.find((e) => e.id === id);
    if (entry) {
      entry.type = "error";
      entry.status = status;
      entry.error = error;
    }
  }

  getStats() {
    return {
      uptime: Date.now() - this.startTime,
      startedAt: this.startTime,
      activeRequests: this.activeRequests,
      totalRequests: this.totalRequests,
      errorCount: this.errorCount,
      providerUsage: this.providerUsage,
    };
  }

  getRecentLog(limit = 20) {
    return this.logEntries.slice(0, limit);
  }
}

export const stats = new StatsCollector();
