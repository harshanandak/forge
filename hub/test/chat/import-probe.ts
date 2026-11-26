import { deepStrictEqual } from "node:assert/strict";
import { Server } from "node:net";
import timers from "node:timers";
import promiseTimers from "node:timers/promises";
import { fakeSlackServer } from "../fakes/fake-slack-server.ts";
import { fixtureEnv, observeSlackEnv } from "./environment.ts";

await using fake = await fakeSlackServer();
using _fixture = fixtureEnv({ SLACK_API_URL: fake.url });
using env = observeSlackEnv();
const effects: string[] = [];
const refuse = (effect: string) => () => {
  effects.push(effect);
  throw new Error("Unexpected import-time " + effect);
};
const timer = refuse("timer");
const timerGuards = {
  setTimeout: timer,
  setInterval: timer,
  setImmediate: timer,
};
Object.assign(globalThis, timerGuards);
Object.assign(timers, timerGuards);
Object.assign(promiseTimers, timerGuards);
Object.assign(promiseTimers.scheduler, {
  wait: refuse("scheduler wait"),
  yield: refuse("scheduler yield"),
});
Server.prototype.listen = refuse("server listener");
process.on("newListener", () => {
  effects.push("process listener");
});

const resources = process.getActiveResourcesInfo().toSorted();
const loaded = process.argv[2]
  ? await import("./import-side-effect.fixture.ts")
  : await import("../../src/chat/index.ts");
deepStrictEqual(
  Object.keys(loaded),
  ["createSlackChatPort", "createTelegramChatPort"],
  "public exports",
);
deepStrictEqual(env.reads, [], "Slack environment reads");
deepStrictEqual(effects, [], "import-time listeners and timers");
deepStrictEqual(fake.calls, [], "Slack API calls");
deepStrictEqual(
  process.getActiveResourcesInfo().toSorted(),
  resources,
  "active resources",
);
process.stdout.write("chat import checked");
