import { expect, test, setDefaultTimeout } from "bun:test";
import {
  call,
  rejection,
  head,
  load,
  prConfig,
  processFake,
  ready,
  reference,
  type Json,
} from "./helpers.ts";
setDefaultTimeout(5000);

function harness(mutation?: { from: string; to: string }) {
  const handlers = load("pr", mutation);
  let current: unknown = ready();
  let revision = 0;
  let fence = true;
  let leaseUntil = 15000;
  let resolveCount = 0;
  let stealAtResolve = 0;
  const timeouts: number[] = [];
  const effects: string[] = [];
  const requests: { action: string; payload: Json }[] = [];
  const writes: Json[] = [];
  let mergeReply: Json = { merged: true, headSha: head };
  const state = {
    now: () => 10000,
    lease: () => ({ expiresAt: new Date(leaseUntil).toISOString() }),
    get: () => (revision ? { revision } : undefined),
    put: (
      _key: string,
      value: Json,
      options: { expectRevision: number; subject?: string },
    ) => {
      if (options.subject && !fence)
        throw Object.assign(new Error("Lease lost"), { code: "LEASE_STALE" });
      if (revision !== options.expectRevision)
        throw new Error("revision conflict");
      effects.push("put");
      writes.push(value);
      return { revision: ++revision };
    },
  };
  const process = processFake((_args, options) => {
    const request = JSON.parse(options.stdin!) as {
      action: string;
      payload: Json;
    };
    effects.push(request.action);
    requests.push(request);
    timeouts.push(options.timeoutMs);
    if (request.action === "status") return { ok: true, result: current };
    if (request.action === "merge") {
      current = { ...ready(), state: "MERGED" };
      return { ok: true, result: mergeReply };
    }
    return { ok: true, result: { accepted: true } };
  });
  const resolve = process.resolve.bind(process);
  process.resolve = (executable, env) => {
    if (++resolveCount === stealAtResolve) fence = false;
    return resolve(executable, env);
  };
  const services = { state, process, environment: { select: () => ({}) } };
  return {
    effects,
    requests,
    writes,
    setMergeReply(value: Json) {
      mergeReply = value;
    },
    timeouts,
    setLeaseExpiry(value: number) {
      leaseUntil = value;
    },
    stealDuringMergeResolution() {
      stealAtResolve = 2;
    },
    set(value: unknown) {
      current = value;
    },
    loseLease() {
      fence = false;
    },
    async invoke(
      op: string,
      input: Json = reference,
      config: unknown = prConfig,
    ): Promise<Json> {
      return (await handlers[`pr.${op}`]!(
        call(input, config, services),
      )) as Json;
    },
  };
}
test("uppercase expectHead is canonicalized before merge comparison, provider launch and state writes", async () => {
  const h = harness();
  const input = {
    ...reference,
    expectHead: head.toUpperCase(),
    expectRevision: 0,
  };
  const result = await h.invoke("merge", input);
  expect(result.verdict).toMatchObject({ status: "MERGED" });
  expect(
    h.requests.find((request) => request.action === "merge")!.payload
      .expectHead,
  ).toBe(head);
  expect(h.writes.every((value) => value.headSha === head)).toBe(true);
  expect(input.expectHead).toBe(head.toUpperCase());
});

test("all accepted provider evidence and merge-result SHAs are canonicalized at their boundaries", async () => {
  const h = harness(),
    e = ready();
  h.set({
    ...e,
    headSha: head.toUpperCase(),
    baseSha: "B".repeat(40),
    mergeableHeadSha: head,
    protection: {
      headSha: head,
      baseSha: "B".repeat(40),
      strictStatusChecks: true,
      atomicBaseCondition: true,
      baseComparison: {
        headSha: head.toUpperCase(),
        baseSha: "b".repeat(40),
        behindBy: 0,
      },
    },
    checks: (e.checks as Json[]).map((value) => ({
      ...value,
      headSha: head.toUpperCase(),
    })),
    reviews: (e.reviews as Json[]).map((value) => ({
      ...value,
      headSha: head.toUpperCase(),
    })),
    threads: [{ id: "T1", resolved: true, headSha: head.toUpperCase() }],
    findings: [{ label: "P1", resolved: true, headSha: head.toUpperCase() }],
  });
  const view = await h.invoke("status");
  expect(view.verdict).toMatchObject({ status: "MERGE_READY" });
  expect(view.evidence).toMatchObject({
    headSha: head,
    baseSha: "b".repeat(40),
    protection: {
      headSha: head,
      baseSha: "b".repeat(40),
      baseComparison: { headSha: head, baseSha: "b".repeat(40) },
    },
    checks: [{ headSha: head }],
    reviews: [{ headSha: head }],
    threads: [{ headSha: head }],
    findings: [{ headSha: head }],
  });
  h.setMergeReply({
    merged: true,
    headSha: head.toUpperCase(),
    mergeSha: "D".repeat(40),
  });
  await h.invoke("merge", {
    ...reference,
    expectHead: head,
    expectRevision: 0,
  });
  expect(h.writes.at(-1)!.merge).toMatchObject({
    headSha: head,
    mergeSha: "d".repeat(40),
  });
});

test("verdict is computed from each fresh provider observation, never a persisted phase", async () => {
  const h = harness();
  const cases: [string, Json][] = [
    ["MERGE_READY", ready()],
    ["INCOMPLETE", { ...ready(), complete: false }],
    ["DRAFT", { ...ready(), draft: true }],
    ["CONFLICTING", { ...ready(), mergeable: "CONFLICTING" }],
    ["CHECKS_PENDING", { ...ready(), checks: [] }],
    [
      "CHECKS_FAILED",
      {
        ...ready(),
        checks: [
          {
            name: "tests",
            appId: 7,
            headSha: head,
            status: "COMPLETED",
            conclusion: "FAILURE",
          },
        ],
      },
    ],
    [
      "REVIEW_BLOCKED",
      { ...ready(), threads: [{ id: "T1", resolved: false, headSha: head }] },
    ],
    ["REVIEW_REQUIRED", { ...ready(), reviews: [] }],
    ["SETTLING", { ...ready(), lastActivityAt: 9950 }],
    ["CLOSED", { ...ready(), state: "CLOSED" }],
    ["MERGED", { ...ready(), state: "MERGED" }],
  ];
  for (const [status, evidence] of cases) {
    h.set(evidence);
    expect((await h.invoke("status")).verdict).toMatchObject({ status });
  }
  expect(h.effects.every((value) => value === "status")).toBe(true);
});
test("malformed and missing observations remain incomplete", async () => {
  const h = harness();
  for (const malformed of [
    null,
    {},
    { ...ready(), repository: undefined },
    { ...ready(), reviews: [{}] },
    { ...ready(), checks: "bad" },
  ]) {
    h.set(malformed);
    expect((await h.invoke("status")).verdict).toMatchObject({
      status: "INCOMPLETE",
    });
  }
});
test("protected checks require this exact head and strict success; optional neutral and skipped are safe", async () => {
  const h = harness();
  for (const conclusion of ["NEUTRAL", "SKIPPED"]) {
    h.set({
      ...ready(),
      checks: [
        ...(ready().checks as unknown[]),
        {
          name: "optional",
          appId: 7,
          headSha: head,
          status: "COMPLETED",
          conclusion,
        },
      ],
    });
    expect((await h.invoke("status")).verdict).toMatchObject({
      status: "MERGE_READY",
    });
    h.set({
      ...ready(),
      checks: [
        {
          name: "tests",
          appId: 7,
          headSha: head,
          status: "COMPLETED",
          conclusion,
        },
      ],
    });
    expect((await h.invoke("status")).verdict).toMatchObject({
      status: "CHECKS_FAILED",
    });
  }
  h.set({
    ...ready(),
    checks: [
      {
        name: "tests",
        appId: 7,
        headSha: "c".repeat(40),
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ],
  });
  expect((await h.invoke("status")).verdict).toMatchObject({
    status: "CHECKS_PENDING",
  });
});
test("stale non-authorizing history carries no approval or blocking authority", async () => {
  const h = harness();
  h.set({
    ...ready(),
    reviews: [
      ...(ready().reviews as unknown[]),
      {
        id: "R0",
        author: "someone",
        headSha: "c".repeat(40),
        state: "COMMENTED",
        updatedAt: 10,
      },
    ],
  });
  expect((await h.invoke("status")).verdict).toMatchObject({
    status: "MERGE_READY",
  });
});
test("merge refuses moved head and a lost lease before an external mutation", async () => {
  const h = harness();
  expect(
    await rejection(
      h.invoke("merge", {
        ...reference,
        expectHead: "c".repeat(40),
        expectRevision: 0,
      }),
    ),
  ).toMatchObject({ code: "HEAD_MOVED" });
  h.loseLease();
  expect(
    await rejection(
      h.invoke("merge", { ...reference, expectHead: head, expectRevision: 0 }),
    ),
  ).toMatchObject({ code: "LEASE_STALE" });
  expect(h.effects).not.toContain("merge");
});
test("merge fences intent, calls exact-head provider and fences accepted result before readback", async () => {
  const h = harness();
  expect(
    (
      await h.invoke("merge", {
        ...reference,
        expectHead: head,
        expectRevision: 0,
      })
    ).verdict,
  ).toMatchObject({ status: "MERGED" });
  expect(h.effects).toEqual(["status", "put", "merge", "put", "status"]);
  expect(
    await rejection(
      h.invoke("merge", {
        ...reference,
        expectHead: head,
        expectRevision: 2,
        body: "Co-authored-by: A <a@example.test>",
      }),
    ),
  ).toMatchObject({ code: "INPUT_INVALID" });
});
test("review replies and resolutions must name a specific thread", async () => {
  const h = harness();
  for (const op of ["reply", "resolve"])
    expect(await rejection(h.invoke(op))).toMatchObject({
      code: "INPUT_INVALID",
    });
  expect(h.effects).toEqual([]);
});

test("merge rechecks the held lease after executable resolution and caps launch to its remaining lifetime", async () => {
  const h = harness();
  h.setLeaseExpiry(10017);
  await h.invoke("merge", {
    ...reference,
    expectHead: head,
    expectRevision: 0,
  });
  expect(h.timeouts[1]).toBe(17);
  const stolen = harness();
  stolen.stealDuringMergeResolution();
  expect(
    await rejection(
      stolen.invoke("merge", {
        ...reference,
        expectHead: head,
        expectRevision: 0,
      }),
    ),
  ).toMatchObject({ code: "LEASE_STALE" });
  expect(stolen.effects).not.toContain("merge");
});

test("coercible array enum values never authorize a merge and extra provider fields are excluded", async () => {
  const h = harness();
  for (const evidence of [
    { ...ready(), mergeable: ["CONFLICTING"] },
    { ...ready(), state: ["CLOSED"] },
    {
      ...ready(),
      checks: [
        {
          name: "tests",
          appId: 7,
          headSha: head,
          status: ["COMPLETED"],
          conclusion: "SUCCESS",
        },
      ],
    },
    {
      ...ready(),
      checks: [
        {
          name: "tests",
          appId: 7,
          headSha: head,
          status: "COMPLETED",
          conclusion: ["SUCCESS"],
        },
      ],
    },
    {
      ...ready(),
      reviews: [
        {
          id: "R1",
          author: "reviewer",
          state: ["APPROVED"],
          headSha: head,
          updatedAt: 1000,
        },
      ],
    },
  ]) {
    h.set(evidence);
    expect((await h.invoke("status")).verdict).toMatchObject({
      status: "INCOMPLETE",
    });
    expect(
      await rejection(
        h.invoke("merge", {
          ...reference,
          expectHead: head,
          expectRevision: 0,
        }),
      ),
    ).toMatchObject({ code: "HEAD_MOVED" });
  }
  expect(h.effects).not.toContain("merge");
  h.set({
    ...ready(),
    unexpected: "discard",
    checks: [{ ...(ready().checks as Json[])[0]!, unexpected: "discard" }],
  });
  const view = await h.invoke("status");
  expect(view.evidence).toEqual(ready());
});

test("duplicate provider review or thread IDs are incomplete and cannot inflate approval authority", async () => {
  const h = harness();
  for (const evidence of [
    {
      ...ready(),
      reviews: [
        {
          id: "R1",
          author: "alice",
          state: "APPROVED",
          headSha: head,
          updatedAt: 1000,
        },
        {
          id: "R1",
          author: "bob",
          state: "APPROVED",
          headSha: head,
          updatedAt: 1000,
        },
      ],
    },
    {
      ...ready(),
      threads: [
        { id: "T1", resolved: true, headSha: head },
        { id: "T1", resolved: true, headSha: head },
      ],
    },
  ]) {
    h.set(evidence);
    expect(
      (await h.invoke("status", reference, { ...prConfig, minApprovals: 2 }))
        .verdict,
    ).toMatchObject({ status: "INCOMPLETE" });
    expect(
      await rejection(
        h.invoke(
          "merge",
          { ...reference, expectHead: head, expectRevision: 0 },
          { ...prConfig, minApprovals: 2 },
        ),
      ),
    ).toMatchObject({ code: "HEAD_MOVED" });
  }
  expect(h.effects).not.toContain("merge");
});

function expectedVerdict(
  view: Json,
  status: string,
  stale: readonly string[],
): void {
  expect(view.verdict).toMatchObject({ status });
  const verdict = view.verdict as { reasons: string[] };
  for (const term of stale)
    expect(
      verdict.reasons.some((reason) => reason.includes(`stale ${term}`)),
    ).toBe(true);
}
test("only current-head checks satisfy existence and protected-check policy", async () => {
  const h = harness();
  const stale = {
    name: "old",
    appId: 7,
    headSha: "c".repeat(40),
    status: "COMPLETED",
    conclusion: "SUCCESS",
  };
  const policy = {
    ...prConfig,
    allowNoChecks: false,
    optionalChecks: "ignore",
  };
  h.set({ ...ready(), requiredChecks: [], checks: [stale] });
  expectedVerdict(await h.invoke("status", reference, policy), "INCOMPLETE", [
    "check",
  ]);
  expect(
    await rejection(
      h.invoke(
        "merge",
        { ...reference, expectHead: head, expectRevision: 0 },
        policy,
      ),
    ),
  ).toMatchObject({ code: "MERGE_BLOCKED" });
  expect(h.effects).not.toContain("merge");
  h.set({
    ...ready(),
    checks: [
      ...(ready().checks as Json[]),
      { ...stale, name: "tests", conclusion: "FAILURE" },
    ],
  });
  expectedVerdict(await h.invoke("status"), "MERGE_READY", ["check"]);
});
test("stale Codex review state is ignored before latest-author selection and approval existence", async () => {
  const h = harness();
  const current = {
    id: "current",
    author: "codex",
    state: "APPROVED",
    headSha: head,
    updatedAt: 1000,
  };
  const stale = {
    id: "old",
    author: "codex",
    state: "CHANGES_REQUESTED",
    headSha: "c".repeat(40),
    updatedAt: 2000,
  };
  h.set({ ...ready(), reviews: [current, stale] });
  expectedVerdict(await h.invoke("status"), "MERGE_READY", ["review"]);
  h.set({ ...ready(), reviews: [{ ...stale, state: "APPROVED" }] });
  expectedVerdict(await h.invoke("status"), "REVIEW_REQUIRED", ["review"]);
  expect(
    await rejection(
      h.invoke("merge", { ...reference, expectHead: head, expectRevision: 0 }),
    ),
  ).toMatchObject({ code: "MERGE_BLOCKED" });
  expect(h.effects).not.toContain("merge");
});
test("mergeability, thread and finding observations are explicitly bound to the current head", async () => {
  const h = harness();
  h.set({ ...ready(), mergeableHeadSha: "c".repeat(40) });
  expectedVerdict(await h.invoke("status"), "INCOMPLETE", ["mergeability"]);
  expect(
    await rejection(
      h.invoke("merge", { ...reference, expectHead: head, expectRevision: 0 }),
    ),
  ).toMatchObject({ code: "MERGE_BLOCKED" });
  expect(h.effects).not.toContain("merge");
  h.set({
    ...ready(),
    threads: [{ id: "old-thread", resolved: false, headSha: "c".repeat(40) }],
    findings: [{ label: "P0", resolved: false, headSha: "c".repeat(40) }],
  });
  expectedVerdict(await h.invoke("status"), "MERGE_READY", [
    "thread",
    "finding",
  ]);
});

test("strict required-check policy requires head/base-bound proof that the head includes the current base", async () => {
  const h = harness(),
    base = "b".repeat(40);
  const protection = {
    headSha: head,
    baseSha: base,
    strictStatusChecks: true,
    atomicBaseCondition: true,
    baseComparison: { headSha: head, baseSha: base, behindBy: 1 },
  };
  h.set({ ...ready(), protection });
  expect((await h.invoke("status")).verdict).toMatchObject({
    status: "CHECKS_PENDING",
  });
  expect(
    await rejection(
      h.invoke("merge", { ...reference, expectHead: head, expectRevision: 0 }),
    ),
  ).toMatchObject({ code: "MERGE_BLOCKED" });
  h.set({
    ...ready(),
    protection: {
      ...protection,
      baseComparison: {
        ...protection.baseComparison,
        behindBy: 0,
        baseSha: "d".repeat(40),
      },
    },
  });
  expect((await h.invoke("status")).verdict).toMatchObject({
    status: "INCOMPLETE",
  });
  h.set({
    ...ready(),
    protection: {
      ...protection,
      baseSha: "d".repeat(40),
      baseComparison: null,
    },
  });
  expect((await h.invoke("status")).verdict).toMatchObject({
    status: "INCOMPLETE",
  });
  expect(h.effects).not.toContain("merge");
  h.set({
    ...ready(),
    protection: {
      ...protection,
      baseComparison: { ...protection.baseComparison, behindBy: 0 },
    },
  });
  expect((await h.invoke("status")).verdict).toMatchObject({
    status: "MERGE_READY",
  });
});

test("strict providers without an atomic base condition never authorize direct merge", async () => {
  const h = harness(),
    base = "b".repeat(40);
  h.set({
    ...ready(),
    protection: {
      headSha: head,
      baseSha: base,
      strictStatusChecks: true,
      atomicBaseCondition: false,
      baseComparison: { headSha: head, baseSha: base, behindBy: 0 },
    },
  });
  expect((await h.invoke("status")).verdict).toMatchObject({
    status: "INCOMPLETE",
  });
  expect(
    await rejection(
      h.invoke("merge", { ...reference, expectHead: head, expectRevision: 0 }),
    ),
  ).toMatchObject({ code: "MERGE_BLOCKED" });
  expect(h.effects).not.toContain("merge");
  expect(h.effects).not.toContain("put");
});
