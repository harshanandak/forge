import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const timeout = 30_000;
const fixture = fileURLToPath(new URL("./serve-fixture.ts", import.meta.url));

function probe(scenario: string): unknown {
  const result = spawnSync("node", [fixture, scenario], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || String(result.signal));
  return JSON.parse(result.stdout);
}

test(
  "S1 Slack-off serve becomes ready after start and stays pending until shutdown",
  () => {
    expect(probe("lifecycle")).toEqual({
      code: 0,
      stderr: [],
      events: [
        "db.open",
        "claim",
        "listening",
        "core.close",
        "release",
        "db.close",
      ],
      ready: 200,
      readyBeforeStartup: false,
      pendingAtReady: true,
      listeningAfter: false,
    });
  },
  timeout,
);

test(
  "S1 shutdown aborts an admitted request before closing remote, core and database",
  () => {
    expect(probe("shutdown")).toMatchObject({
      code: 0,
      stderr: [],
      events: [
        "db.open",
        "claim",
        "listening",
        "abort",
        "remote.close",
        "core.close",
        "release",
        "db.close",
      ],
      pending: "closed",
      listeningAfter: false,
    });
  },
  timeout,
);

test(
  "S1 shutdown closes remote, core and database only after an aborted handler settles",
  () => {
    expect(probe("drain")).toMatchObject({
      code: 0,
      stderr: [],
      events: [
        "db.open",
        "claim",
        "listening",
        "abort",
        "handler.settled",
        "remote.close",
        "core.close",
        "release",
        "db.close",
      ],
      pending: "closed",
      listeningAfter: false,
    });
  },
  timeout,
);

test(
  "S4 a server error after listen drains an aborted handler before closing resources",
  () => {
    expect(probe("error")).toMatchObject({
      code: 1,
      stderr: ["could not run hub service\n"],
      events: [
        "db.open",
        "claim",
        "listening",
        "abort",
        "handler.settled",
        "remote.close",
        "core.close",
        "release",
        "db.close",
      ],
      pending: "closed",
      listeningAfter: false,
    });
  },
  timeout,
);

for (const [scenario, name, middle] of [
  ["early", "a stop during slow startup skips binding an occupied port", []],
  ["late", "signals during delayed remote and core cleanup", ["listening"]],
  [
    "signals",
    "repeated real signals during drain",
    ["listening", "abort", "handler.settled"],
  ],
  [
    "pipelined",
    "shutdown cancels a queued pipelined request that never sees close",
    ["listening", "abort", "abort", "handler.settled", "handler.settled"],
  ],
  [
    "stream",
    "shutdown awaits a streaming body's async cancel",
    ["listening", "cancel", "cancel.settled"],
  ],
] as const) {
  test(
    "S1 " + name + " keeps remote, core and database open until it settles",
    () => {
      expect(probe(scenario)).toMatchObject({
        code: 0,
        stderr: [],
        events: [
          "db.open",
          "claim",
          ...middle,
          "remote.close",
          "core.close",
          "release",
          "db.close",
        ],
        listeningAfter: false,
      });
    },
    timeout,
  );
}

for (const [scenario, startup] of [
  ["port", ["claim"]],
  ["chat", ["claim", "chat.start", "chat.stop", "release"]],
  ["reconcile", ["claim", "chat.start", "reconcile", "chat.stop", "release"]],
] as const) {
  test(
    "S4 cleans up and sanitizes the " + scenario + " startup failure",
    () => {
      expect(probe(scenario)).toMatchObject({
        code: 1,
        stderr: ["could not run hub service\n"],
        events: [
          "db.open",
          ...startup,
          "remote.close",
          "core.close",
          ...(scenario === "port" ? ["release"] : []),
          "db.close",
        ],
        listeningAfter: false,
      });
    },
    timeout,
  );
}

test(
  "S4 Telegram selection is refused before resources open",
  () => {
    expect(probe("telegram")).toMatchObject({
      code: 1,
      stderr: ["Telegram is unavailable for the hub service\n"],
      events: [],
      listeningAfter: false,
    });
  },
  timeout,
);

test(
  "H-limit the Node service fixes its limit and rejects a saturated header view before dispatch",
  () => {
    const result = probe("headers") as { node: string };
    const [major = 0, minor = 0, patch = 0] = result.node
      .split(".")
      .map(Number);
    const at = major * 1e6 + minor * 1e3 + patch;
    const patched = at >= 26_005_001 || (major === 24 && at >= 24_018_001);
    expect(result).toMatchObject({
      code: 0,
      events: [
        "db.open",
        "claim",
        "chat.start",
        "reconcile",
        "listening",
        "remote.close",
        "core.close",
        "chat.stop",
        "release",
        "db.close",
      ],
      headers: {
        fixed: true,
        atLimit: 403,
        hiddenHost: patched ? 431 : 403,
        chatCalls: 0,
        remoteCalls: 0,
        belowLimit: 200,
      },
    });
  },
  timeout,
);

test(
  "H-limit stable positive, unlimited and default settings use the parser cutoff",
  () => {
    expect(probe("boundary")).toEqual([
      [200, 403],
      [200, 200],
      [200, 403],
    ]);
  },
  timeout,
);
