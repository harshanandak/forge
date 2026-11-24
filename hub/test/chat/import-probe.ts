import { deepStrictEqual } from "node:assert/strict";
import { fakeSlackServer } from "../fakes/fake-slack-server.ts";
import { fixtureEnv, observeSlackEnv } from "./environment.ts";

await using fake = await fakeSlackServer();
using _fixture = fixtureEnv({ SLACK_API_URL: fake.url });
using env = observeSlackEnv();
const resources = process.getActiveResourcesInfo().toSorted();
const loaded = await import("../../src/chat/index.ts");
deepStrictEqual(Object.keys(loaded), ["createSlackChatPort"], "public exports");
deepStrictEqual(env.reads, [], "Slack environment reads");
deepStrictEqual(fake.calls, [], "Slack API calls");
deepStrictEqual(
  process.getActiveResourcesInfo().toSorted(),
  resources,
  "active resources",
);
process.stdout.write("chat import checked");
