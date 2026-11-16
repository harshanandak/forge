import { test, setDefaultTimeout } from "bun:test";
import { deepStrictEqual as eq } from "node:assert/strict";
import { limitsFrom, restorePage } from "../../cloud/src/dump.ts";
import { domain } from "../../cloud/src/project.ts";
import * as impl from "../../tools/import-current-state.ts";
import * as f from "./import-current-state.fixture.ts";
import { createStateClient } from "../../src/assembly/state-client.ts";
import { refuse } from "../../src/core/trust/index.ts";
import { validateAttempt } from "../../src/generated/validators.ts";
import type { HandlerCall } from "../../src/contract/author.ts";
import type { Attempt } from "../../src/generated/types.ts";

setDefaultTimeout(30_000);

const workShapes = [
  [
    "landing:work-1:42",
    {
      id: "work-1",
      pr: 42,
      receipt: "check-1",
      branch: "fix/one",
      worktree: "/fixture",
      generation: 1,
      head: "a".repeat(40),
      mergeCommit: "b".repeat(40),
      note: "landed",
    },
  ],
  ["reopen:work-1:1", { reason: "retry", holder: f.holder }],
  [
    "attempt:work-1:attempt-1",
    {
      id: "attempt-1",
      holder: f.holder,
      baseRevision: 1,
      createdAt: new Date(f.at).toISOString(),
    },
  ],
  [
    "evidence:attempt:work-1:attempt-1:1",
    {
      attempt: "attempt-1",
      sha: "a".repeat(40),
      holder: f.holder,
      recordedAt: new Date(f.at).toISOString(),
    },
  ],
  ["cleanup:work-1", { expiresAt: new Date(f.at + 60000).toISOString() }],
  [
    "selection:work-1",
    {
      mode: "single",
      chosen: [{ attempt: "attempt-1", sha: "a".repeat(40) }],
      reason: "chosen",
      holder: f.holder,
      selectedAt: new Date(f.at).toISOString(),
    },
  ],
  ["slots:work-1", { count: 2, next: 1 }],
] as const;

test("all seven writer families survive projection and paged readback", () => {
  const source = f.source(6, false, false, (_db, state) => {
    for (const [key, value] of workShapes)
      state.put(f.ns, key, value, f.actor, { expectRevision: 0 });
  });
  const scratch = f.database();
  f.owner(scratch).initialize();
  const projected = impl.currentState(
    source.db,
    scratch,
    source.manifest,
    limitsFrom({}),
  );
  eq(projected.records, 13);
  eq(projected.events, 13);
  const target = f.cloudDatabase(),
    owner = f.owner(target);
  owner.initialize([domain]);
  for (const page of impl.pagesOf(scratch, limitsFrom({})))
    restorePage(target, owner, page, limitsFrom({}));
  for (const [key, value] of workShapes) eq(owner.get(f.ns, key)?.value, value);
  eq(target.all("SELECT * FROM state_leases"), []);
  console.log("forge-1453 synthetic projection", JSON.stringify(projected));
  const handlers = require("../../src/blocks/work/entry.cts") as Record<
    string,
    (call: Partial<HandlerCall<Record<string, unknown>>>) => {
      attempts: Attempt[];
    }
  >;
  const globals = globalThis as Record<string, unknown>,
    previous = globals.fail;
  globals.fail = refuse;
  try {
    const before = f.snapshot(target);
    const shown = handlers["issue.show"]!({
      input: { id: "work-1" },
      config: { idPrefix: "work" },
      services: {
        state: createStateClient({
          owner,
          namespace: f.ns,
          write: false,
          requestId: "restored-show",
          context: {
            variant: "project",
            actor: f.actor,
            project: { id: "fixture" },
          },
        }),
      },
    });
    const attempt = shown.attempts[0]!;
    eq([attempt.id, attempt.live, attempt.evidence], ["attempt-1", false, 1]);
    eq([attempt.generation, attempt.expiresAt], [undefined, undefined]);
    eq(validateAttempt(attempt).ok, true);
    eq(validateAttempt({ ...attempt, live: true }).ok, false);
    eq(f.snapshot(target), before);
  } finally {
    if (previous === undefined) delete globals.fail;
    else globals.fail = previous;
  }
});

test.each([
  "landing:work-1:0",
  "landing:work-1:01",
  "landing:work-1:42:extra",
  "reopen:work-1:0",
  "reopen:work-1:01",
  "reopen:work-1:1:extra",
  "attempt:work-1:other",
  "attempt:work-1:attempt-0",
  "attempt:work-1:attempt-01",
  "evidence:attempt:work-1:attempt-1:0",
  "evidence:attempt:work-1:attempt-1:01",
  "cleanup:",
  "cleanup:work-1:extra",
  "selection:work-1:extra",
  "slots:work-1:extra",
  "journal:work-1",
  "lane-control:global",
])("unsupported work shape still refuses: %s", (key) => {
  eq(impl.ordinaryKey(f.ns, key), false);
  eq(impl.ordinaryKey("forge/cloud", "issue:work-1"), false);
});
