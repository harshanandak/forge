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
  const state = {
    now: () => 10000,
    lease: () => ({ expiresAt: new Date(leaseUntil).toISOString() }),
    get: () => (revision ? { revision } : undefined),
    put: (
      _key: string,
      _value: unknown,
      options: { expectRevision: number; subject?: string },
    ) => {
      if (options.subject && !fence)
        throw Object.assign(new Error("Lease lost"), { code: "LEASE_STALE" });
      if (revision !== options.expectRevision)
        throw new Error("revision conflict");
      effects.push("put");
      return { revision: ++revision };
    },
  };
  const process = processFake((_args, options) => {
    const request = JSON.parse(options.stdin!) as {
      action: string;
      payload: Json;
    };
    effects.push(request.action);
    timeouts.push(options.timeoutMs);
    if (request.action === "status") return { ok: true, result: current };
    if (request.action === "merge") {
      current = { ...ready(), state: "MERGED" };
      return { ok: true, result: { merged: true, headSha: head } };
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
      { ...ready(), threads: [{ id: "T1", resolved: false }] },
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
        { id: "T1", resolved: true },
        { id: "T1", resolved: true },
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
