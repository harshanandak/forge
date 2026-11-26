import { expect, test } from "bun:test";
import { p1 } from "./fixture.ts";
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
