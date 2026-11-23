import { expect, test } from "bun:test";
import { fakeSlackServer } from "../fakes/fake-slack-server.ts";
import { observeSlackEnv } from "./environment.ts";

const timeout = 30_000;

test(
  "C9 importing the public chat module creates no listener, timer, API call or Slack env read",
  async () => {
    await using fake = await fakeSlackServer();
    using env = observeSlackEnv();
    const resources = process.getActiveResourcesInfo().toSorted();
    const loaded = await import("../../src/chat/index.ts");
    expect(Object.keys(loaded)).toEqual(["createSlackChatPort"]);
    expect(env.reads).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(process.getActiveResourcesInfo().toSorted()).toEqual(resources);
  },
  timeout,
);
