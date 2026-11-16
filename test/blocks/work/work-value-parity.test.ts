import { test, setDefaultTimeout } from "bun:test";
import { deepStrictEqual as eq, throws } from "node:assert/strict";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { BoundContext } from "../../../src/generated/types.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";

setDefaultTimeout(30_000);
const at = "2026-11-16T00:00:00.000Z";
const actor = { kind: "agent", id: "value-parity" } as const;
const holder = { actor, session: { id: "parity", device: "fixture" } };
const issue = {
  id: "work-1",
  title: "one",
  status: "open",
  labels: [],
  dependsOn: [],
  createdAt: at,
};
const checkpoint = {
  step: "green",
  branch: "fix/one",
  worktree: "/fixture",
  next: "review",
};
const primary: readonly [string, unknown, string?][] = [
  ["issue:work-1", issue],
  ["issue:work-1", { ...issue, id: "bogus" }, "WORK_VALUE_ID"],
  ["issue:work-1", { ...issue, parent: "bogus" }, "WORK_VALUE_ID"],
  ["issue:work-1", { ...issue, dependsOn: ["bogus"] }, "WORK_VALUE_ID"],
  ["issue:work-1", { ...issue, title: "" }, "WORK_VALUE_SHAPE"],
  ["issue:work-1", { ...issue, revision: 1 }, "WORK_VALUE_SHAPE"],
  ["issue:work-1", null, "WORK_VALUE_SHAPE"],
  ["comment:work-1:1", { id: "work-1", body: "plain" }],
  ["comment:work-1:1", { id: "work-1", body: "call", call: 1 }],
  ["comment:work-1:1", { id: "work-1", body: "checkpoint", checkpoint }],
  [
    "comment:work-1:1",
    { id: "work-1", body: "both", call: 1, checkpoint },
    "WORK_VALUE_COMMENT_KIND",
  ],
  [
    "comment:work-1:1",
    { id: "work-1", body: "call", call: 0 },
    "WORK_VALUE_SHAPE",
  ],
  ["comment:work-1:1", null, "WORK_VALUE_SHAPE"],
  [
    "link:work-1:1",
    { id: "work-1", relation: "delivers", url: "https://example.test/pull/1" },
  ],
  [
    "link:work-1:1",
    { id: "work-1", relation: "docs", url: "http://example.test/one" },
  ],
  [
    "link:work-1:1",
    { id: "work-1", relation: "docs", url: "javascript:alert(1)" },
    "WORK_VALUE_URL",
  ],
  ["link:work-1:1", null, "WORK_VALUE_SHAPE"],
];
const other: readonly [string, unknown, string?][] = [
  [
    "attempt:work-1:attempt-1",
    { id: "attempt-1", holder, baseRevision: 1, createdAt: at },
  ],
  [
    "evidence:attempt:work-1:attempt-1:1",
    { attempt: "attempt-1", sha: "a".repeat(40), holder, recordedAt: at },
  ],
  [
    "landing:work-1:1",
    {
      id: "work-1",
      pr: 1,
      receipt: "check-1",
      branch: "fix/one",
      worktree: "/fixture",
      note: "landed",
      generation: 1,
      head: "a".repeat(40),
      mergeCommit: "b".repeat(40),
    },
  ],
  ["reopen:work-1:1", { reason: "retry", holder }],
  ["cleanup:work-1", { expiresAt: at }],
  ["slots:work-1", { count: 2, next: 0 }],
  [
    "selection:work-1",
    { mode: "none", chosen: [], reason: "retry", holder, selectedAt: at },
  ],
  ["allocation:issue:work-", { prefix: "issue:work-", number: 1 }],
  ["participant:work-1:1", { holder }],
  ["note:attempt:work-1:attempt-1:1", { attempt: "attempt-1", body: "one" }],
  ["autopilot-clock:work-1", { startedAt: at }],
  ["autopilot-event:work-1:1", { id: "work-1", type: "done", at, detail: {} }],
  ["autopilot:global", { stopped: {} }],
  [
    "autopilot-merge:work-1",
    { head: "a".repeat(40), verdict: "MERGE", reviewer: "reviewer", at },
  ],
];
const cases = [
  ...primary,
  ...other,
  ...other.map(([key]) => [key, null, "WORK_VALUE_SHAPE"] as const),
  ["future-family:work-1", {}, "WORK_VALUE_FAMILY"] as const,
  ["issue:bogus", { ...issue, id: "bogus" }, "WORK_VALUE_KEY"] as const,
];
for (const [index, [key, value, reason]] of cases.entries()) {
  const routes = primary.some((row) => row[0] === key)
    ? ["put", "batch", "acquire", "numbered"]
    : ["put", "batch", "acquire"];
  for (const route of routes)
    test(`work value parity ${index} ${route}: ${reason ?? "valid"}`, async () => {
      const opened = await createSqliteStore(process.cwd()).open({
        path: ":memory:",
        readOnly: false,
      });
      if (!opened.ok) throw new Error("Fixture store refused");
      const db = opened.handle.value;
      try {
        const owner = new StateOwner(db, { now: () => Date.parse(at) });
        owner.initialize();
        const context: BoundContext =
          route === "acquire"
            ? {
                variant: "leased",
                leaseMode: "acquire",
                actor,
                session: holder.session,
                project: { id: "fixture" },
              }
            : { variant: "project", actor, project: { id: "fixture" } };
        const client = createStateClient({
          owner,
          namespace: "forge/work",
          context,
          write: true,
          requestId: `parity-${index}`,
        });
        const entry = { key, value, expectRevision: 0 };
        const write = () => {
          if (route === "put")
            return client.put(key, value, { expectRevision: 0 });
          if (route === "batch") return client.putMany([entry]);
          if (route === "acquire")
            return client.acquire("issue:work-1", 60_000, { entries: [entry] });
          return client.putNext(key.replace(/\d+$/, ""), () => ({ value }));
        };
        if (reason) {
          throws(
            write,
            (error: unknown) =>
              error instanceof ForgeFailure &&
              error.error.code === "INPUT_INVALID" &&
              error.error.message === reason,
          );
          for (const table of ["state_records", "state_events", "state_leases"])
            eq(db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n, 0);
        } else {
          write();
          eq(owner.get("forge/work", key)?.value, value);
        }
      } finally {
        await opened.handle.close();
      }
    });
}
