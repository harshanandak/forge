import { expect, test } from "bun:test";
import {
  MAX_SUPERVISORS,
  validateSupervision,
} from "../../../src/adapters/process/supervision.ts";

// `launchInJob` marks the command's pipe ends inheritable only for the instant before CreateProcessW,
// and its comment relies on one command starting at a time. Raising this limit means redoing that
// reasoning (for example, serializing launches), so the limit is pinned here.
test("only one supervised command runs at a time", () => {
  expect(MAX_SUPERVISORS).toBe(1);
  expect(() =>
    validateSupervision({
      cleanupTimeoutMs: 5000,
      pollIntervalMs: 25,
      drainTimeoutMs: 250,
      maxConcurrent: 2,
    }),
  ).toThrow("maxConcurrent");
}, 5_000);
