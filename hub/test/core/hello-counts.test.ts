import { expect, test } from "bun:test";
import { baseFixture } from "./base-fixture.ts";
import { p1, p2, seedItem } from "./fixture.ts";

const timeout = 30_000;

test(
  "B1B-HELLO1 hello counts reflect the newly bound project",
  async () => {
    const f = await baseFixture();
    const opening = f.unbound();
    seedItem(f.db, "itm_p1_waiting", { projectId: p1 });
    seedItem(f.db, "itm_p2_waiting_one", { projectId: p2 });
    seedItem(f.db, "itm_p2_waiting_two", { projectId: p2 });
    const modeBefore = f.rows(
      "sessions WHERE session_id = ?",
      "mode,mode_reason,untrusted_read_seq",
      opening.sessionId,
    );

    const hello = f.bindProject(opening.sessionId, p1);

    expect(hello).toMatchObject({ unread: 1, unreadFromOthers: 1 });
    expect(hello.mode).toBe("reply_only");
    expect(
      f.col("sessions WHERE session_id = ?", "project_id", opening.sessionId),
    ).toEqual([p1]);
    expect(f.col("inbox_items ORDER BY item_id", "target_session_id")).toEqual([
      null,
      null,
      null,
    ]);
    expect(
      f.rows(
        "sessions WHERE session_id = ?",
        "mode,mode_reason,untrusted_read_seq",
        opening.sessionId,
      ),
    ).toEqual(modeBefore);
  },
  timeout,
);
