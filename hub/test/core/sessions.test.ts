import { expect, test } from "bun:test";
import { a, p1, seedHost, seedItem, sessionFixture, value } from "./fixture.ts";

const timeout = 30_000;

test(
  "S1: hook registration returns unread counts and ids without contents",
  async () => {
    const { db, sessions } = await sessionFixture();
    seedHost(db);
    seedItem(db, "itm_pending");
    const result = value(
      sessions.hookSession(
        { person: a, hostInstanceId: "hst_a" },
        {
          host: "claude",
          hostSessionId: "one",
          source: "startup",
        },
      ),
    );
    expect(result).toEqual({
      sessionId: result.sessionId,
      mode: "normal",
      unread: 1,
      unreadFromOthers: 1,
      itemIds: ["itm_pending"],
    });
    expect(
      db.prepare("SELECT delivered_at FROM inbox_items").get()?.delivered_at,
    ).toBeNull();
  },
  timeout,
);

test(
  "S2: only own, current and eligible items qualify",
  async () => {
    const { db, sessions } = await sessionFixture();
    const owner = sessions.createUnboundSession(a, undefined, "claude");
    const other = sessions.createUnboundSession(a, undefined, "claude");
    db.exec(
      "INSERT INTO projects (project_id,name,front_person_id) VALUES ('prj_left','Left','per_b')",
    );
    seedItem(db, "itm_held", { held: true });
    seedItem(db, "itm_left", { projectId: "prj_left" });
    seedItem(db, "itm_other", { target: other.sessionId });
    seedItem(db, "itm_pending", { projectId: p1 });
    seedItem(db, "itm_outstanding", { delivered: owner.sessionId });
    seedItem(db, "itm_left_outstanding", {
      projectId: "prj_left",
      delivered: owner.sessionId,
    });
    const rows = () =>
      db.prepare("SELECT * FROM inbox_items ORDER BY item_id").all();
    const before = rows();
    expect(sessions.deliverable(owner, 20).map((item) => item.itemId)).toEqual([
      "itm_pending",
    ]);
    expect(sessions.outstanding(owner, 20).map((item) => item.itemId)).toEqual([
      "itm_outstanding",
    ]);
    expect(sessions.unreadCounts(owner)).toEqual({
      unread: 1,
      unreadFromOthers: 1,
      itemIds: ["itm_pending"],
    });
    expect(rows()).toEqual(before);
  },
  timeout,
);
