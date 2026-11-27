import { expect, spyOn, test } from "bun:test";
import type { MainServices } from "../../src/main.ts";
import { createHubCore, nullTracker } from "../../src/core/index.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { mainFixture } from "../main/main-fixture.ts";
import { doorbellFake, fakeHostCore } from "./base-fakes.ts";
import { button } from "./fakes.ts";
import {
  a,
  closeDb,
  configPeople,
  fixture,
  onFixtureCleanup,
} from "./fixture.ts";

const timeout = 30_000;
const sweepMs = 60_000;

async function compositionFixture() {
  const f = await fixture();
  const chat = new FakeChatPort(f.config.slack.teamId);
  const doorbell = doorbellFake(true);
  const events: string[] = [];
  const db = {
    ...f.db,
    claimWorker() {
      events.push("claim");
      const claim = f.db.claimWorker();
      return {
        release() {
          events.push("release");
          claim.release();
        },
      };
    },
    close() {
      events.push("db.close");
      closeDb(f.db);
    },
  };
  const deps = {
    ...f,
    db,
    people: configPeople(f.config.people),
    doorbell: doorbell.port,
    tracker: nullTracker,
  };
  function track(core: ReturnType<typeof createHubCore>) {
    onFixtureCleanup(() => core.close());
    return core;
  }
  return { ...f, db, chat, deps, track, events, rings: doorbell.rings };
}

test(
  "C1 the exported factory builds a complete idle core",
  async () => {
    const f = await compositionFixture();
    const timers = spyOn(globalThis, "setTimeout");
    try {
      const core = f.track(createHubCore({ ...f.deps, chat: f.chat }));
      expect(Object.keys(core).sort()).toEqual(
        Object.keys(fakeHostCore(core)).sort(),
      );
      expect(core.person(a.personId)).toMatchObject(a);
      expect(f.chat.calls.map(({ name }) => name)).toEqual([]);
      expect(f.events).toEqual([]);
      expect(f.rings).toEqual([]);
      expect(timers).toHaveBeenCalledTimes(0);
    } finally {
      timers.mockRestore();
    }
  },
  timeout,
);

for (const argv of [
  ["token", "create", "--person", a.personId],
  ["token", "revoke", "--token", "tok_fixture"],
  ["host", "create", "--person", a.personId],
  ["host", "revoke", "--host", "hst_fixture"],
  ["inbox", "--project", "prj_one"],
  ["send", "--project", "prj_one"],
]) {
  test(
    "C2 " + argv.slice(0, 2).join(" ") + " closes each acquired resource once",
    async () => {
      const f = await compositionFixture();
      const loadCore: MainServices["loadCore"] = () =>
        Promise.resolve({
          nullTracker,
          openHubDb: () => f.db,
          createHubCore(deps) {
            const core = f.track(createHubCore(deps));
            return {
              ...core,
              close() {
                f.events.push("core.close");
                return core.close();
              },
            };
          },
        });
      const entry = mainFixture({
        loadConfig: () => f.config,
        loadCore,
        runAdminCommand: (args, { core }) => {
          f.events.push("admin");
          expect(args).toEqual(argv);
          expect(core.person(a.personId)).toMatchObject(a);
          return Promise.resolve(0);
        },
      });
      expect(await entry.run(argv)).toBe(0);
      expect(f.events).toEqual(["admin", "core.close", "db.close"]);
    },
    timeout,
  );
}

test(
  "C3 closing a core leaves the database to its caller",
  async () => {
    const f = await compositionFixture();
    const core = f.track(createHubCore(f.deps));
    const closing = core.close();
    expect(core.close()).toBe(closing);
    await closing;
    expect(f.events).toEqual([]);
    expect(f.db.prepare("SELECT 1 AS open").get()).toEqual({ open: 1 });
    await expect(core.start()).rejects.toThrow("Hub core is closed");
  },
  timeout,
);

test(
  "C3 concurrent starts share ownership, handlers and one sweep",
  async () => {
    const f = await compositionFixture();
    const originalStart = f.chat.start.bind(f.chat);
    const originalStop = f.chat.stop.bind(f.chat);
    f.chat.start = (handlers) => {
      f.events.push("start");
      return originalStart(handlers);
    };
    f.chat.stop = () => {
      f.events.push("stop");
      return originalStop();
    };
    const core = f.track(createHubCore({ ...f.deps, chat: f.chat }));
    const timers = spyOn(globalThis, "setTimeout");
    const cancel = spyOn(globalThis, "clearTimeout");
    try {
      const start = core.start();
      expect(core.start()).toBe(start);
      await start;
      expect(f.chat.calls[0]?.args[0]).toBe(core.chatHandlers);
      expect(f.events).toEqual(["claim", "start"]);
      const sweeps = timers.mock.calls
        .map(
          ([, delay], index) =>
            delay === sweepMs && timers.mock.results[index]?.value,
        )
        .filter(Boolean);
      expect(sweeps).toHaveLength(1);
      const close = core.close();
      expect(core.close()).toBe(close);
      await close;
      expect(f.events).toEqual(["claim", "start", "stop", "release"]);
      expect(cancel).toHaveBeenCalledWith(sweeps[0]);
    } finally {
      timers.mockRestore();
      cancel.mockRestore();
    }
  },
  timeout,
);

test(
  "C3 close during chat startup waits for it and cancels effect startup",
  async () => {
    const f = await compositionFixture();
    const core = f.track(createHubCore({ ...f.deps, chat: f.chat }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalStart = f.chat.start.bind(f.chat);
    f.chat.start = async (handlers) => {
      entered.resolve();
      await release.promise;
      await originalStart(handlers);
    };
    const timers = spyOn(globalThis, "setTimeout");
    try {
      const start = core.start();
      await entered.promise;
      const close = core.close();
      expect(f.events).toEqual(["claim"]);
      release.resolve();
      await Promise.all([start, close]);
      expect(f.chat.calls.map(({ name }) => name)).toEqual(["start", "stop"]);
      expect(f.events).toEqual(["claim", "release"]);
      expect(() => f.chat.emitAction(button("unused", "unused"))).toThrow(
        "fake chat is stopped",
      );
      expect(timers.mock.calls.some(([, delay]) => delay === sweepMs)).toBe(
        false,
      );
    } finally {
      release.resolve();
      timers.mockRestore();
    }
  },
  timeout,
);

test(
  "C3 a failed chat startup stops chat and releases the worker claim",
  async () => {
    const f = await compositionFixture();
    const core = f.track(createHubCore({ ...f.deps, chat: f.chat }));
    const start = f.chat.start.bind(f.chat);
    f.chat.start = async (handlers) => {
      await start(handlers);
      throw new Error("injected chat failure");
    };
    await expect(core.start()).rejects.toThrow("injected chat failure");
    await core.close();
    expect(f.chat.calls.map(({ name }) => name)).toEqual(["start", "stop"]);
    expect(f.events).toEqual(["claim", "release"]);
  },
  timeout,
);
