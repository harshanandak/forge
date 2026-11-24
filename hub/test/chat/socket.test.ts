import { expect, test } from "bun:test";
import { appId, team } from "../fakes/fake-slack-server.ts";
import {
  slackCases,
  eventKeys,
  callback,
  changed,
  subscribedChanges,
  deleted,
  dm,
  fixtureSecret,
  mention,
  replyTs,
  rootTs,
  slackFixture,
  waitFor,
} from "./fixtures.ts";

const timeout = 30_000;
const { started: startedCase } = slackCases(test, timeout);

test(
  "W12 W12c the Socket Mode wire retry count gives no duplicate or missed delivery",
  async () => {
    const secrets: string[] = [];
    await using h = await slackFixture({
      mode: "socket",
      secret(name) {
        secrets.push(name);
        return fixtureSecret(name);
      },
    });
    await h.start();
    const socket = h.fake.socket;
    if (!socket) throw new Error("socket fixture is unavailable");
    const first = callback(dm(), "Ev0SOCKET");
    expect(await socket.send("events_api", first, 1)).toMatchObject({
      envelope_id: "envelope-1",
    });
    await waitFor(() => h.messages.length === 1);
    expect(await socket.send("events_api", first, 2)).toMatchObject({
      envelope_id: "envelope-2",
    });
    const unseen = callback(dm({ ts: replyTs, thread_ts: rootTs }), "Ev0RETRY");
    expect(await socket.send("events_api", unseen, 3)).toMatchObject({
      envelope_id: "envelope-3",
    });
    await waitFor(() => h.messages.length === 2);
    await h.stop();
    expect(h.messages.map(({ chatMessageId }) => chatMessageId)).toEqual([
      rootTs,
      replyTs,
    ]);
    expect(secrets.toSorted()).toEqual(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
  },
  timeout,
);

startedCase(
  "WP1 TM1 TM2 Socket Mode drops the wrong team before either dedupe key",
  async (h) => {
    const socket = h.fake.socket;
    if (!socket) throw new Error("socket fixture is unavailable");
    expect(
      await socket.send("events_api", callback(dm(), "Ev0PIN", "T0OTHER"), 1),
    ).toMatchObject({ envelope_id: "envelope-1" });
    expect(h.messages).toEqual([]);
    expect(eventKeys(h)).toEqual([]);
    expect(
      await socket.send("events_api", callback(dm(), "Ev0PIN", team), 3),
    ).toMatchObject({ envelope_id: "envelope-2" });
    await waitFor(() => h.messages.length === 1);
    await h.stop();
    expect(h.messages).toHaveLength(1);
    expect(h.logs).toContainEqual({ event: "chat.warn", fields: { count: 1 } });
  },
  { mode: "socket" },
);

startedCase(
  "BI2 MC1 MC2 Socket Mode filters the app's own posts and maps edits and deletes",
  async (h) => {
    const socket = h.fake.socket;
    if (!socket) throw new Error("socket fixture is unavailable");
    await socket.send(
      "events_api",
      callback(dm({ app_id: appId }), "Ev0OWNAPP"),
    );
    await socket.send(
      "events_api",
      callback(
        dm({ bot_profile: { app_id: appId }, ts: replyTs }),
        "Ev0OWNPROFILE",
      ),
    );
    await socket.send("events_api", callback(mention(), "Ev0MENTION"));
    await waitFor(() => h.messages.some((message) => message.mentionsBot));
    await socket.send("events_api", callback(changed(), "Ev0EDIT"));
    await waitFor(() => h.changes.length === 1);
    await socket.send("events_api", callback(deleted(), "Ev0DELETE"));
    await waitFor(() => h.changes.length === 2);
    await h.stop();
    expect(h.messages).toHaveLength(1);
    expect(h.changes).toEqual(subscribedChanges);
  },
  { mode: "socket" },
);
