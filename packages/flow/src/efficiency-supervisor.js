"use strict";

const THRESHOLDS = Object.freeze([
  Object.freeze({ percent: 20, type: "REPLAN" }),
  Object.freeze({ percent: 30, type: "REPLAN" }),
  Object.freeze({ percent: 35, type: "TERMINAL_PATH" }),
  Object.freeze({ percent: 39, type: "STOP" }),
]);

class EfficiencySupervisor {
  constructor(options = {}) {
    const { tokenBudget } = options;
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
      throw new TypeError("tokenBudget must be a positive safe integer");
    }

    this.tokenBudget = tokenBudget;
    this.lastTrustworthyTokens = 0;
    this.emittedThresholds = new Set();
    this.terminal = false;
    this.terminalPath = null;
    this.status = "CONTINUE";
  }

  observe(sample = {}) {
    if (sample === null || typeof sample !== "object" || Array.isArray(sample)) {
      return this._failClosed("INVALID_USAGE");
    }
    if (this.terminal) {
      return this._result([]);
    }

    const { totalTokens } = sample;
    if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
      return this._failClosed("INVALID_USAGE");
    }
    if (totalTokens < this.lastTrustworthyTokens) {
      return this._failClosed("REGRESSING_USAGE");
    }

    this.lastTrustworthyTokens = totalTokens;
    const usagePercent = (totalTokens / this.tokenBudget) * 100;
    const actions = [];

    for (const threshold of THRESHOLDS) {
      if (this.emittedThresholds.has(threshold.percent)
        || usagePercent < threshold.percent) {
        continue;
      }

      this.emittedThresholds.add(threshold.percent);
      if (threshold.type === "TERMINAL_PATH") {
        this.terminalPath = sample.outcomeComplete === true ? "COMPLETE" : "HANDOFF";
        this.status = "TERMINAL_PATH";
        actions.push({ type: this.terminalPath, thresholdPercent: threshold.percent });
        continue;
      }

      actions.push({ type: threshold.type, thresholdPercent: threshold.percent });
      if (threshold.type === "STOP") {
        this.terminal = true;
        this.status = sample.outcomeComplete === true ? "COMPLETE" : "INCOMPLETE";
      }
    }

    return this._result(actions);
  }

  _failClosed(reason) {
    this.terminal = true;
    this.status = "INCOMPLETE";
    return this._result([{ type: "STOP", reason }]);
  }

  _result(actions) {
    return {
      status: this.status,
      terminal: this.terminal,
      terminalPath: this.terminalPath,
      tokenBudget: this.tokenBudget,
      totalTokens: this.lastTrustworthyTokens,
      lastTrustworthyTokens: this.lastTrustworthyTokens,
      usagePercent: (this.lastTrustworthyTokens * 100) / this.tokenBudget,
      actions,
    };
  }
}

module.exports = { EfficiencySupervisor, THRESHOLDS };
