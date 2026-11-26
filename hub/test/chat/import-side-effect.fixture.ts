import { Server } from "node:net";
import { scheduler } from "node:timers/promises";

try {
  switch (process.argv[2]) {
    case "env":
      void process.env.SLACK_API_URL;
      break;
    case "process listener":
      process.once("beforeExit", () => undefined);
      break;
    case "timer":
      setTimeout(() => undefined, 0);
      break;
    case "scheduler wait":
      await scheduler.wait(0);
      break;
    case "scheduler yield":
      await scheduler.yield();
      break;
    case "server listener":
      new Server().listen(0, "127.0.0.1");
      break;
  }
} catch {
  await Promise.resolve();
}

export const createSlackChatPort = undefined;
export const createTelegramChatPort = undefined;
