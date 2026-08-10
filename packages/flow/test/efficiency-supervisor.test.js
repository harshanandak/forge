"use strict";

const { describe, expect, test } = require("bun:test");
const { EfficiencySupervisor } = require("../src/efficiency-supervisor.js");

describe("EfficiencySupervisor", () => {
  test("emits each crossed replan checkpoint once and in deterministic order", () => {
    const supervisor = new EfficiencySupervisor({ tokenBudget: 10_000 });

    expect(supervisor.observe({ totalTokens: 1_999 }).actions).toEqual([]);
    expect(supervisor.observe({ totalTokens: 3_001 }).actions).toEqual([
      { type: "REPLAN", thresholdPercent: 20 },
      { type: "REPLAN", thresholdPercent: 30 },
    ]);
    expect(supervisor.observe({ totalTokens: 3_001 }).actions).toEqual([]);
    expect(supervisor.observe({ totalTokens: 3_499 }).actions).toEqual([]);
  });

  test("chooses bounded completion at 35% when the outcome is complete", () => {
    const supervisor = new EfficiencySupervisor({ tokenBudget: 1_000 });
    supervisor.observe({ totalTokens: 349 });

    expect(supervisor.observe({ totalTokens: 350, outcomeComplete: true })).toMatchObject({
      status: "TERMINAL_PATH",
      actions: [{ type: "COMPLETE", thresholdPercent: 35 }],
      terminalPath: "COMPLETE",
    });
  });

  test("chooses a resumable handoff at 35% when the outcome is incomplete", () => {
    const supervisor = new EfficiencySupervisor({ tokenBudget: 1_000 });
    supervisor.observe({ totalTokens: 349 });

    expect(supervisor.observe({ totalTokens: 350 })).toMatchObject({
      status: "TERMINAL_PATH",
      actions: [{ type: "HANDOFF", thresholdPercent: 35 }],
      terminalPath: "HANDOFF",
    });
  });

  test("hard-stops new work at the strict 39% terminal threshold", () => {
    const supervisor = new EfficiencySupervisor({ tokenBudget: 1_000 });

    expect(supervisor.observe({ totalTokens: 390 })).toMatchObject({
      status: "INCOMPLETE",
      terminal: true,
      actions: [
        { type: "REPLAN", thresholdPercent: 20 },
        { type: "REPLAN", thresholdPercent: 30 },
        { type: "HANDOFF", thresholdPercent: 35 },
        { type: "STOP", thresholdPercent: 39 },
      ],
    });
    expect(supervisor.observe({ totalTokens: 391 }).actions).toEqual([]);
  });

  test("preserves a terminal COMPLETE result when later input is malformed", () => {
    const supervisor = new EfficiencySupervisor({ tokenBudget: 1_000 });
    const terminal = supervisor.observe({ totalTokens: 390, outcomeComplete: true });

    expect(supervisor.observe(null)).toEqual({ ...terminal, actions: [] });
  });

  test.each([
    [true, false, "COMPLETE", "COMPLETE"],
    [false, true, "HANDOFF", "INCOMPLETE"],
  ])("keeps the 35%% terminal path locked at the 39%% stop", (initialComplete, laterComplete, terminalPath, status) => {
    const supervisor = new EfficiencySupervisor({ tokenBudget: 1_000 });
    supervisor.observe({ totalTokens: 350, outcomeComplete: initialComplete });

    expect(supervisor.observe({ totalTokens: 390, outcomeComplete: laterComplete })).toMatchObject({
      status,
      terminal: true,
      terminalPath,
      actions: [{ type: "STOP", thresholdPercent: 39 }],
    });
  });

  test.each([
    ["null", null],
    ["string", "not-a-sample"],
    ["number", 10],
    ["array", []],
    ["missing", {}],
    ["negative", { totalTokens: -1 }],
    ["fractional", { totalTokens: 10.5 }],
    ["non-numeric", { totalTokens: "200" }],
  ])("fails closed on %s provider usage", (_label, sample) => {
    const supervisor = new EfficiencySupervisor({ tokenBudget: 1_000 });

    expect(supervisor.observe(sample)).toMatchObject({
      status: "INCOMPLETE",
      terminal: true,
      actions: [{ type: "STOP", reason: "INVALID_USAGE" }],
      lastTrustworthyTokens: 0,
    });
  });

  test("fails closed on regressing usage and preserves the last trustworthy count", () => {
    const supervisor = new EfficiencySupervisor({ tokenBudget: 1_000 });
    supervisor.observe({ totalTokens: 250 });

    expect(supervisor.observe({ totalTokens: 249 })).toMatchObject({
      status: "INCOMPLETE",
      terminal: true,
      actions: [{ type: "STOP", reason: "REGRESSING_USAGE" }],
      lastTrustworthyTokens: 250,
    });
  });

  test.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1e308])("rejects an invalid declared budget (%s)", (tokenBudget) => {
    expect(() => new EfficiencySupervisor({ tokenBudget })).toThrow(
      "tokenBudget must be a positive safe integer",
    );
  });

  test.each([Number.MAX_SAFE_INTEGER + 1, 1e308])(
    "fails closed on unsafe provider usage (%s)",
    (totalTokens) => {
      const supervisor = new EfficiencySupervisor({ tokenBudget: 1_000 });

      expect(supervisor.observe({ totalTokens })).toMatchObject({
        status: "INCOMPLETE",
        terminal: true,
        actions: [{ type: "STOP", reason: "INVALID_USAGE" }],
        lastTrustworthyTokens: 0,
      });
    },
  );
});
