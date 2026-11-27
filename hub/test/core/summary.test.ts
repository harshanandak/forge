import { expect, test } from "bun:test";
import { LIMITS, type ReportInput } from "../../src/contract/mcp.ts";
import { refusal, until } from "./base-fakes.ts";
import { a, b, p1, value } from "./fixture.ts";
import { holdFirstSummaryEdit } from "./life-fakes.ts";
import { lifeFixture } from "./life-fixture.ts";

const timeout = 30_000;

test(
  "E3 keeps an uncertain and then missing summary pending without posting",
  async () => {
    const f = await lifeFixture();
    f.queueSummary();
    const summary = "SELECT * FROM summaries WHERE project_id = ?";
    const effect =
      "SELECT status, attempts, next_attempt_at FROM summary_effects WHERE project_id = ?";
    const initial = f.rows(summary, p1);
    expect(initial).toHaveLength(1);

    f.chat.nextWrite = { kind: "unknown" };
    await f.worker.drain();
    expect(f.rows(effect, p1)).toEqual([
      { status: "pending", attempts: 1, next_attempt_at: f.now() + 1_000 },
    ]);
    expect(f.chat.writes).toMatchObject([
      { name: "editSummary", args: [f.ref, expect.any(Object)] },
    ]);

    f.chat.provisionSummary(f.ref.channelId, f.publicationKey, {
      ...f.ref,
      chatMessageId: "replacement-outside-hub",
    });
    f.advance(1_000);
    await f.worker.drain();
    expect(await f.worker.waitForSummary(p1, 1)).toBe("queued");
    expect(f.rows(effect, p1)).toEqual([
      { status: "pending", attempts: 2, next_attempt_at: f.now() + 5_000 },
    ]);
    expect(f.rows(summary, p1)).toEqual(initial);
    expect(f.chat.calls.filter(({ name }) => name !== "start")).toMatchObject([
      { name: "editSummary", args: [f.ref, expect.any(Object)] },
      { name: "editSummary", args: [f.ref, expect.any(Object)] },
    ]);
  },
  timeout,
);

type LifeFixture = Awaited<ReturnType<typeof lifeFixture>>;
type BoundOwner = ReturnType<LifeFixture["bind"]>;

const issue = "demo-12";
const otherIssue = "demo-13";
const permits =
  "SELECT permit_id, person_id, request_ask_id, issue_id FROM permits ORDER BY person_id";
const summaryRevision =
  "SELECT revision, published_revision FROM summaries WHERE project_id = ?";
const summaryEffect =
  "SELECT target_revision, status FROM summary_effects WHERE project_id = ?";

function reportInput(sessionId: string, requestAskId: string, issueId = issue) {
  return {
    sessionId,
    requestAskId,
    issueId,
    projectId: p1,
    state: "working",
    text: "Reviewing the approved work.",
  } satisfies ReportInput;
}

async function approve(f: LifeFixture, session: BoundOwner, issueId = issue) {
  const id = await f.workRequest(session.owner, session.sessionId, issueId);
  await f.answer(session.owner, id, "approve");
  return reportInput(session.sessionId, id, issueId);
}

function expectNoReport(f: LifeFixture) {
  expect(f.rows("SELECT project_id FROM summary_lines")).toEqual([]);
  expect(f.rows(summaryRevision, p1)).toEqual([]);
  expect(f.rows(summaryEffect, p1)).toEqual([]);
}

function expectRevision(
  f: LifeFixture,
  revision: number,
  published = revision,
) {
  expect(f.rows(summaryRevision, p1)).toEqual([
    { revision, published_revision: published },
  ]);
}

function expectSummaryEdits(f: LifeFixture, revisions: readonly number[]) {
  const summaryCalls = ["editSummary", "postSummary", "findSummary"];
  expect(
    f.chat.calls.filter(({ name }) => summaryCalls.includes(name)),
  ).toMatchObject(
    revisions.map((revision) => ({
      name: "editSummary",
      args: [f.ref, { revision }],
    })),
  );
}

test(
  "U1 requires approval after a pending, declined, clarified or expired request",
  async () => {
    const f = await lifeFixture();
    const session = f.bind();
    const { owner, sessionId } = session;
    const pending = await f.workRequest(owner, sessionId, issue);
    const decline = reportInput(sessionId, pending);
    expect(refusal(await f.report(owner, decline)).code).toBe(
      "PERMIT_REQUIRED",
    );
    expectNoReport(f);

    await f.answer(owner, pending, "decline");
    expect(refusal(await f.report(owner, decline)).code).toBe(
      "PERMIT_REQUIRED",
    );
    expectNoReport(f);

    const clarify = await f.workRequest(owner, sessionId, issue);
    await f.answer(owner, clarify, "clarify");
    expect(
      refusal(await f.report(owner, reportInput(sessionId, clarify))).code,
    ).toBe("PERMIT_REQUIRED");
    expectNoReport(f);

    const expired = await f.workRequest(owner, sessionId, issue);
    f.advance(60_000);
    await f.answer(owner, expired, "approve");
    expect(f.rows("SELECT status FROM asks WHERE ask_id = ?", expired)).toEqual(
      [{ status: "expired" }],
    );
    expect(
      refusal(await f.report(owner, reportInput(sessionId, expired))).code,
    ).toBe("PERMIT_REQUIRED");
    expectNoReport(f);
    expect(f.rows(permits)).toEqual([]);

    const approved = await approve(f, session);
    const stored = f.rows(permits);
    expect(stored).toMatchObject([
      {
        person_id: a.personId,
        request_ask_id: approved.requestAskId,
        issue_id: issue,
      },
    ]);
    expect(value(await f.report(owner, approved))).toMatchObject({
      permitId: stored[0]?.permit_id,
      summaryRevision: 1,
    });
  },
  timeout,
);

test(
  "U2 refuses a report about an issue outside its approved request",
  async () => {
    const f = await lifeFixture();
    const session = f.bind();
    const approved = await approve(f, session);
    const before = f.rows(permits);
    expect(before).toHaveLength(1);

    const rejected = await f.report(session.owner, {
      ...approved,
      issueId: otherIssue,
    });
    expect(refusal(rejected).code).toBe("PERMIT_REQUIRED");
    expect(f.rows(permits)).toEqual(before);
    expectNoReport(f);
  },
  timeout,
);

test(
  "U3 refuses a choice answer and another person's approval as authority",
  async () => {
    const f = await lifeFixture();
    const session = f.bind();
    expect(
      f.rows(
        "SELECT mode, untrusted_read_seq FROM sessions WHERE session_id = ?",
        session.sessionId,
      ),
    ).toEqual([{ mode: "normal", untrusted_read_seq: 0 }]);
    const choice = await f.answerChoice([a.personId], issue);
    expect(
      f.rows("SELECT choice_id FROM ask_answers WHERE ask_id = ?", choice),
    ).toEqual([{ choice_id: "first" }]);
    expect(f.rows(permits)).toEqual([]);
    const other = f.bind(b);
    const approved = await approve(f, other);

    for (const requestAskId of [choice, approved.requestAskId]) {
      const rejected = await f.report(
        session.owner,
        reportInput(session.sessionId, requestAskId),
      );
      expect(refusal(rejected).code).toBe("PERMIT_REQUIRED");
      expectNoReport(f);
    }
    expect(f.rows(permits)).toMatchObject([
      { person_id: b.personId, request_ask_id: approved.requestAskId },
    ]);
  },
  timeout,
);

test(
  "U4 reuses one permit and advances the revision across two database handles",
  async () => {
    const f = await lifeFixture();
    const session = f.bind();
    const input = await approve(f, session);
    const peerReport = f.peerReport();

    const first = value(await f.report(session.owner, input));
    const second = value(
      await peerReport(session.owner, {
        ...input,
        text: "Approved work checked.",
      }),
    );
    expect(first.summaryRevision).toBe(1);
    expect(second).toMatchObject({
      permitId: first.permitId,
      summaryRevision: 2,
    });
    expect(f.rows(permits)).toMatchObject([
      { permit_id: first.permitId, request_ask_id: input.requestAskId },
    ]);
    expect(
      f.rows("SELECT revision FROM summaries WHERE project_id = ?", p1),
    ).toEqual([{ revision: 2 }]);
  },
  timeout,
);

test(
  "V1 edits the configured summary in place on two reports",
  async () => {
    const f = await lifeFixture();
    const session = f.bind();
    const input = await approve(f, session);
    expect(value(await f.report(session.owner, input))).toMatchObject({
      summary: "edited",
      summaryRevision: 1,
    });
    expectRevision(f, 1);
    expect(
      value(await f.report(session.owner, { ...input, state: "done" })),
    ).toMatchObject({ summary: "edited", summaryRevision: 2 });
    expectRevision(f, 2);
    expectSummaryEdits(f, [1, 2]);
  },
  timeout,
);

test(
  "E1.rebind edits the replacement configured summary after reopening",
  async () => {
    const f = await lifeFixture();
    const session = f.bind();
    const input = await approve(f, session);
    const first = value(await f.report(session.owner, input));
    expect(first).toMatchObject({ summary: "edited", summaryRevision: 1 });
    expectSummaryEdits(f, [1]);
    await f.worker.drain();
    const publicationKey =
      "SELECT publication_key FROM summaries WHERE project_id = ?";
    const original = f.rows(publicationKey, p1);

    const reopened = await f.reopen({
      ...f.ref,
      chatThreadId: "3.000001",
      chatMessageId: "3.000001",
    });
    const second = value(
      await reopened.report(session.owner, { ...input, state: "done" }),
    );
    expect(second.summaryRevision).toBe(2);
    expect(second.summary).toBe("edited");
    expectSummaryEdits(reopened, [2]);
    expectRevision(reopened, 2);
    expect(reopened.rows(publicationKey, p1)).toEqual(original);
  },
  timeout,
);

test(
  "V2 upserts by person and issue and records the reporting session's host label",
  async () => {
    const f = await lifeFixture();
    const first = f.bind(a, "first-report");
    const next = f.bind(a, "second-report");
    const other = f.bind(b);
    const one = await approve(f, first);
    const two = await approve(f, next, otherIssue);
    const three = await approve(f, other);
    const done = {
      ...one,
      state: "done",
      text: "Finished the review.",
    } as const;
    const blocked = {
      ...two,
      state: "blocked",
      text: "Waiting for input.",
    } as const;

    value(await f.report(first.owner, one));
    value(await f.report(next.owner, blocked));
    value(await f.report(other.owner, three));
    value(await f.report(first.owner, done));

    const rows = f.rows(
      "SELECT person_id, issue_key, host_label, state, text FROM summary_lines WHERE project_id = ? ORDER BY person_id, issue_key",
      p1,
    );
    expect(rows).toEqual(
      (
        [
          [first, done],
          [next, blocked],
          [other, three],
        ] as const
      ).map(([session, input]) => ({
        person_id: session.owner.person.personId,
        issue_key: input.issueId,
        host_label: "claude " + session.sessionId.slice(0, 8),
        state: input.state,
        text: input.text,
      })),
    );
  },
  timeout,
);

function waitForEdit(started: Promise<void>, report: Promise<unknown>) {
  return Promise.race([
    started,
    report.then(() => {
      throw new Error("The report finished before its summary edit began");
    }),
  ]);
}

test(
  "E2 serializes a newer revision behind the first edit",
  async () => {
    const f = await lifeFixture();
    const session = f.bind();
    const input = await approve(f, session);
    const edit = holdFirstSummaryEdit(f.chat);

    const first = f.report(session.owner, input);
    let second: typeof first;
    try {
      await waitForEdit(edit.started, first);
      second = f.report(session.owner, { ...input, state: "done" });
      await until(
        () => f.rows(summaryEffect, p1)[0]?.target_revision === 2,
        LIMITS.reportWaitMs,
      );
      expect(f.rows(summaryEffect, p1)).toEqual([
        { target_revision: 2, status: "pending" },
      ]);
      expectRevision(f, 2, 0);
      expectSummaryEdits(f, [1]);
    } finally {
      edit.release();
    }

    expect(value(await first)).toMatchObject({
      summaryRevision: 1,
      summary: "edited",
    });
    expect(value(await second)).toMatchObject({
      summaryRevision: 2,
      summary: "edited",
    });
    expectSummaryEdits(f, [1, 2]);
    expectRevision(f, 2);
    expect(f.rows(summaryEffect, p1)).toEqual([
      { target_revision: 2, status: "done" },
    ]);
  },
  timeout,
);

test(
  "E2 a stale completion never lowers the persisted published revision",
  async () => {
    const f = await lifeFixture();
    const session = f.bind();
    const input = await approve(f, session);
    const db = f.openPeer();
    const edit = holdFirstSummaryEdit(f.chat);

    const report = f.report(session.owner, input);
    try {
      await waitForEdit(edit.started, report);
      db.transaction(() => {
        db.prepare(
          "UPDATE summaries SET revision = 2, published_revision = 2 WHERE project_id = ?",
        ).run(p1);
        db.prepare(
          "UPDATE summary_effects SET target_revision = 2, status = 'done' WHERE project_id = ?",
        ).run(p1);
      });
    } finally {
      edit.release();
    }

    expect(value(await report)).toMatchObject({
      summaryRevision: 1,
      summary: "edited",
    });
    await f.worker.drain();
    expectRevision(f, 2);
    expect(f.rows(summaryEffect, p1)).toEqual([
      { target_revision: 2, status: "done" },
    ]);
  },
  timeout,
);
