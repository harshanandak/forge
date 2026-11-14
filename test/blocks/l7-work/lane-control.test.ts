import { expect, test } from "bun:test";
import {
  readLaneControl,
  transitionLaneControl,
  checkLaneObservation,
} from "../../../src/blocks/work/lane-control.ts";
import { exitCode } from "../../../src/surface/result.ts";

const at = "2026-11-14T01:00:00.000Z";
function fixture() {
  return {
    global: {
      version: 1,
      incarnation: "history-1",
      epoch: 4,
      resumeAllEpoch: 0,
      stopAll: null as string | null,
    },
    issue: {
      version: 1,
      incarnation: "history-1",
      id: "work-1367",
      epoch: 3,
      stoppedAt: at as string | null,
    },
    command: {
      action: "resume",
      scope: { id: "work-1367" } as { id?: string; all?: boolean },
    },
    context: { project: "forge", policyIdentity: "owner-policy-1", now: at },
    authorization: {
      status: "verified",
      project: "forge",
      policyIdentity: "owner-policy-1",
      scope: { id: "work-1367" } as { id?: string; all?: boolean },
      incarnation: "history-1",
      epoch: 4,
      expiresAt: "2026-11-14T01:10:00.000Z",
    },
    observation: {
      id: "work-1367",
      requestedAt: 100,
      control: { incarnation: "history-1", epoch: 4, stopped: false },
    } as {
      id: string;
      requestedAt: number;
      control: {
        incarnation: string;
        epoch: number;
        stopped: boolean;
        scope?: string;
        since?: string;
      };
    } | null,
    expected: { id: "work-1367", incarnation: "history-1", epoch: 4 },
    observedNow: 101,
  };
}
type Fixture = ReturnType<typeof fixture>;
function unchanged<T, R>(
  input: T,
  run: () => R,
  snapshot: (value: T) => unknown = structuredClone,
): R {
  const before = snapshot(input);
  const result = run();
  expect(snapshot(input)).toEqual(before);
  return result;
}

for (const field of [
  "global",
  "issue",
  "command",
  "context",
  "authorization",
] as const) {
  test(`accessor in ${field} is refused without invocation`, () => {
    const f = fixture();
    let calls = 0;
    const value = { ...f[field] };
    const key = Object.keys(value)[0]!;
    Object.defineProperty(value, key, {
      get() {
        calls++;
        return "untrusted";
      },
      enumerable: true,
    });
    const inputs = { ...f, [field]: value };
    const snapshot = () => ({
      ...structuredClone(f),
      accessor: Object.getOwnPropertyDescriptors(value),
    });
    const result = unchanged(
      inputs,
      () =>
        transitionLaneControl(
          inputs.global,
          inputs.issue,
          inputs.command,
          inputs.context,
          inputs.authorization,
        ),
      snapshot,
    );
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("result.candidate");
    expect(calls).toBe(0);
  }, 1000);
}
type Row = readonly [string, (f: Fixture) => void, string | null];
for (const alias of ["forge-1367", "WORK-1367", "not/an/issue"]) {
  for (const field of [
    "command",
    "authorization",
    "issue",
    "observation",
    "expected",
  ] as const) {
    test(`non-canonical ${field} identity ${alias}`, () => {
      const f = fixture();
      if (field === "command" || field === "authorization")
        f[field].scope.id = alias;
      else if (field === "observation") f.observation!.id = alias;
      else f[field].id = alias;
      const result = unchanged(f, () =>
        field === "observation" || field === "expected"
          ? checkLaneObservation(f.observation, f.expected, f.observedNow)
          : transitionLaneControl(
              f.global,
              f.issue,
              f.command,
              f.context,
              f.authorization,
            ),
      );
      expect(result.status).toBe("FAIL");
      if (!result.ok) expect(result.error.code).toBe("INPUT_INVALID");
      expect(result).not.toHaveProperty("result.candidate");
      if (field === "command" || field === "issue") {
        const read = unchanged(f, () =>
          readLaneControl(f.global, f.issue, f.command.scope),
        );
        expect(read.status).toBe("FAIL");
        if (!read.ok) expect(read.error.code).toBe("INPUT_INVALID");
        expect(read).not.toHaveProperty("result.candidate");
      }
    }, 1000);
  }
}

for (const kind of ["prototype", "extra key"] as const) {
  for (const [field, code] of [
    ["global", "UNAVAILABLE"],
    ["issue", "UNAVAILABLE"],
    ["command", "INPUT_INVALID"],
    ["context", "INPUT_INVALID"],
    ["authorization", "APPROVAL_REQUIRED"],
    ["command scope", "INPUT_INVALID"],
    ["authorization scope", "INPUT_INVALID"],
    ["observation", "UNAVAILABLE"],
    ["expected", "UNAVAILABLE"],
    ["control", "UNAVAILABLE"],
  ] as const) {
    test(`${kind} on otherwise-valid ${field}`, () => {
      const f = fixture();
      const target =
        field === "command scope"
          ? f.command.scope
          : field === "authorization scope"
            ? f.authorization.scope
            : field === "control"
              ? f.observation!.control
              : f[field];
      if (kind === "prototype") Object.setPrototypeOf(target, { custom: true });
      else
        Object.defineProperty(target, "extra", {
          value: true,
          enumerable: true,
        });
      const prototype: unknown = Object.getPrototypeOf(target);
      const result = unchanged(f, () =>
        ["observation", "expected", "control"].includes(field)
          ? checkLaneObservation(f.observation, f.expected, f.observedNow)
          : transitionLaneControl(
              f.global,
              f.issue,
              f.command,
              f.context,
              f.authorization,
            ),
      );
      expect(result.status).toBe("FAIL");
      if (!result.ok) expect(result.error.code).toBe(code);
      expect(result).not.toHaveProperty("result.candidate");
      expect(Object.getPrototypeOf(target)).toBe(prototype);
      if (field === "global" || field === "issue") {
        const read = unchanged(f, () =>
          readLaneControl(f.global, f.issue, f.command.scope),
        );
        expect(read.status).toBe("FAIL");
        if (!read.ok) expect(read.error.code).toBe(code);
        expect(read).not.toHaveProperty("result.candidate");
      }
    }, 1000);
  }
}

const transitions: Row[] = [
  ["single resume", () => {}, null],
  [
    "new stop",
    (f) => {
      f.command.action = "stop";
      f.issue.stoppedAt = null;
    },
    null,
  ],
  [
    "reassert stop",
    (f) => {
      f.command.action = "stop";
    },
    null,
  ],
  [
    "global stop",
    (f) => {
      f.command = { action: "stop", scope: { all: true } };
    },
    null,
  ],
  [
    "single under global",
    (f) => {
      f.global.stopAll = at;
    },
    "INPUT_CONFLICT",
  ],
  [
    "resume all",
    (f) => {
      f.global.stopAll = at;
      f.command.scope = { all: true };
      f.authorization.scope = { all: true };
    },
    null,
  ],
  [
    "pending authorization",
    (f) => {
      f.authorization.status = "pending";
    },
    "APPROVAL_REQUIRED",
  ],
  [
    "expiry boundary",
    (f) => {
      f.authorization.expiresAt = at;
    },
    "APPROVAL_REQUIRED",
  ],
  [
    "expired authorization",
    (f) => {
      f.authorization.expiresAt = "2026-11-14T00:00:00Z";
    },
    "APPROVAL_REQUIRED",
  ],
  [
    "changed epoch",
    (f) => {
      f.authorization.epoch--;
    },
    "INPUT_CONFLICT",
  ],
  [
    "wrong project",
    (f) => {
      f.authorization.project = "another";
    },
    "INPUT_CONFLICT",
  ],
  [
    "wrong scope",
    (f) => {
      f.authorization.scope = { all: true };
    },
    "INPUT_CONFLICT",
  ],
  [
    "wrong issue",
    (f) => {
      f.authorization.scope.id = "work-2";
    },
    "INPUT_CONFLICT",
  ],
  [
    "wrong incarnation",
    (f) => {
      f.authorization.incarnation = "history-2";
    },
    "INPUT_CONFLICT",
  ],
  [
    "changed policy",
    (f) => {
      f.authorization.policyIdentity = "owner-policy-2";
    },
    "INPUT_CONFLICT",
  ],
  [
    "both scopes",
    (f) => {
      f.command.scope.all = true;
    },
    "INPUT_INVALID",
  ],
  [
    "neither scope",
    (f) => {
      f.command.scope = {};
    },
    "INPUT_INVALID",
  ],
  [
    "empty id",
    (f) => {
      f.command.scope.id = "";
    },
    "INPUT_INVALID",
  ],
  [
    "false all",
    (f) => {
      f.command.scope = { all: false };
    },
    "INPUT_INVALID",
  ],
  [
    "unknown action",
    (f) => {
      f.command.action = "dispatch";
    },
    "INPUT_INVALID",
  ],
  [
    "invalid clock",
    (f) => {
      f.context.now = "2026-02-30T00:00:00Z";
    },
    "INPUT_INVALID",
  ],
  [
    "overflow",
    (f) => {
      f.global.epoch = Number.MAX_SAFE_INTEGER;
    },
    "UNAVAILABLE",
  ],
];
for (const [name, change, code] of transitions) {
  test(
    name,
    () => {
      const f = fixture();
      change(f);
      const result = unchanged(f, () =>
        transitionLaneControl(
          f.global,
          f.issue,
          f.command,
          f.context,
          f.authorization,
        ),
      );
      expect(result.status).toBe(code === null ? "OK" : "FAIL");
      expect(exitCode(result)).toBe(
        code === null
          ? 0
          : code === "INPUT_INVALID"
            ? 6
            : code === "INPUT_CONFLICT"
              ? 4
              : 1,
      );
      if (!result.ok) {
        expect(result.error.code).toBe(code!);
        expect(result).not.toHaveProperty("result.candidate");
        return;
      }
      const candidate = result.result.candidate;
      expect(candidate.global.epoch).toBe(5);
      expect(candidate.global).not.toBe(f.global);
      expect(candidate.issue).not.toBe(f.issue);
      if (f.command.scope.all) {
        expect(candidate.issue).toBeUndefined();
        expect(candidate.global.stopAll).toBe(
          f.command.action === "stop" ? at : null,
        );
        if (f.command.action === "resume")
          expect(candidate.global.resumeAllEpoch).toBe(5);
      } else {
        expect(candidate.issue?.epoch).toBe(5);
        expect(candidate.issue?.stoppedAt).toBe(
          f.command.action === "stop" ? at : null,
        );
        expect(candidate.global.resumeAllEpoch).toBe(0);
      }
    },
    1000,
  );
}

for (const authorization of [
  undefined,
  null,
  { quote: "yes", source: { thread: "owner" } },
  { actor: "human", approved: true },
]) {
  test(`unverified authorization ${JSON.stringify(authorization)}`, () => {
    const f = fixture();
    const inputs = { f, authorization };
    const result = unchanged(inputs, () =>
      transitionLaneControl(
        f.global,
        f.issue,
        f.command,
        f.context,
        authorization,
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("APPROVAL_REQUIRED");
    expect(result).not.toHaveProperty("result.candidate");
  }, 1000);
}

const states: Row[] = [
  [
    "bad global version",
    (f) => {
      f.global.version = 2;
    },
    "UNAVAILABLE",
  ],
  [
    "negative epoch",
    (f) => {
      f.global.epoch = -1;
    },
    "UNAVAILABLE",
  ],
  [
    "unsafe epoch",
    (f) => {
      f.global.epoch = Number.MAX_SAFE_INTEGER + 1;
    },
    "UNAVAILABLE",
  ],
  [
    "fractional epoch",
    (f) => {
      f.global.epoch = 4.5;
    },
    "UNAVAILABLE",
  ],
  [
    "watermark ahead",
    (f) => {
      f.global.resumeAllEpoch = 5;
    },
    "UNAVAILABLE",
  ],
  [
    "negative watermark",
    (f) => {
      f.global.resumeAllEpoch = -1;
    },
    "UNAVAILABLE",
  ],
  [
    "invalid global time",
    (f) => {
      f.global.stopAll = "yesterday";
    },
    "UNAVAILABLE",
  ],
  [
    "bad row version",
    (f) => {
      f.issue.version = 2;
    },
    "UNAVAILABLE",
  ],
  [
    "row ahead",
    (f) => {
      f.issue.epoch = 5;
    },
    "UNAVAILABLE",
  ],
  [
    "zero row epoch",
    (f) => {
      f.issue.epoch = 0;
    },
    "UNAVAILABLE",
  ],
  [
    "row incarnation mismatch",
    (f) => {
      f.issue.incarnation = "old";
    },
    "UNAVAILABLE",
  ],
  [
    "row issue mismatch",
    (f) => {
      f.issue.id = "work-2";
    },
    "UNAVAILABLE",
  ],
  [
    "invalid row time",
    (f) => {
      f.issue.stoppedAt = "2026-02-30T01:00:00Z";
    },
    "UNAVAILABLE",
  ],
];
for (const [name, change, code] of states) {
  test(
    name,
    () => {
      const f = fixture();
      change(f);
      for (const result of [
        unchanged(f, () => readLaneControl(f.global, f.issue, f.command.scope)),
        unchanged(f, () =>
          transitionLaneControl(
            f.global,
            f.issue,
            f.command,
            f.context,
            f.authorization,
          ),
        ),
      ]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe(code!);
        expect(exitCode(result)).toBe(1);
        expect(result).not.toHaveProperty("result.candidate");
      }
    },
    1000,
  );
}

for (const [name, stopAll, row, watermark, scope] of [
  ["running", null, false, 0, undefined],
  ["newly seen under global stop", at, false, 0, "all"],
  ["individual", null, true, 0, "issue"],
  ["global precedence", at, true, 0, "all"],
  ["old stop cleared", null, true, 3, undefined],
  ["resume watermark equals epoch", null, true, 4, undefined],
  ["stop after watermark", null, true, 2, "issue"],
] as const) {
  test(
    name,
    () => {
      const f = fixture();
      f.global.stopAll = stopAll;
      f.global.resumeAllEpoch = watermark;
      const input = {
        global: f.global,
        issue: row ? f.issue : null,
        scope: f.command.scope,
      };
      const result = unchanged(input, () =>
        readLaneControl(input.global, input.issue, input.scope),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result).toEqual({
        incarnation: "history-1",
        epoch: 4,
        stopped: scope !== undefined,
        ...(scope ? { scope, since: at } : {}),
      });
    },
    1000,
  );
}

test("resume all clears multiple rows without scanning, then a later stop wins", () => {
  const f = fixture();
  f.command.scope = f.authorization.scope = { all: true };
  const result = unchanged(f, () =>
    transitionLaneControl(
      f.global,
      null,
      f.command,
      f.context,
      f.authorization,
    ),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.result.candidate.global.resumeAllEpoch).toBe(
    result.result.candidate.global.epoch,
  );
  for (const id of ["work-1367", "work-2"]) {
    const inputs = {
      global: { ...result.result.candidate.global },
      issue: { ...f.issue, id },
      scope: { id },
    };
    const read = unchanged(inputs, () =>
      readLaneControl(inputs.global, inputs.issue, inputs.scope),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.result).toEqual({
      incarnation: "history-1",
      epoch: 5,
      stopped: false,
    });
    inputs.issue.epoch = 6;
    inputs.global.epoch = 6;
    const later = unchanged(inputs, () =>
      readLaneControl(inputs.global, inputs.issue, inputs.scope),
    );
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.result).toEqual({
      incarnation: "history-1",
      epoch: 6,
      stopped: true,
      scope: "issue",
      since: at,
    });
  }
}, 1000);

test("stop then resume back to running invalidates the original authorization", () => {
  const f = fixture();
  const inputs = {
    ...f,
    global: { ...f.global, epoch: 6 },
    issue: { ...f.issue, epoch: 6, stoppedAt: null },
  };
  const result = unchanged(inputs, () =>
    transitionLaneControl(
      inputs.global,
      inputs.issue,
      f.command,
      f.context,
      f.authorization,
    ),
  );
  expect(!result.ok && result.error.code).toBe("INPUT_CONFLICT");
}, 1000);

for (const global of [null, undefined, {}, { version: 1 }, []]) {
  test(`unknown global ${JSON.stringify(global)}`, () => {
    const f = fixture();
    const inputs = { f, global };
    for (const result of [
      unchanged(inputs, () => readLaneControl(global, null, {})),
      unchanged(inputs, () =>
        transitionLaneControl(
          global,
          null,
          f.command,
          f.context,
          f.authorization,
        ),
      ),
    ])
      expect(!result.ok && result.error.code).toBe("UNAVAILABLE");
  }, 1000);
}

const observations: Row[] = [
  ["fresh from request start", () => {}, null],
  [
    "expiry at 20 seconds",
    (f) => {
      f.observedNow = 20100;
    },
    "UNAVAILABLE",
  ],
  [
    "future request",
    (f) => {
      f.observation!.requestedAt = 102;
    },
    "UNAVAILABLE",
  ],
  [
    "wrong lane",
    (f) => {
      f.expected.id = "work-2";
    },
    "UNAVAILABLE",
  ],
  [
    "changed incarnation",
    (f) => {
      f.expected.incarnation = "history-2";
    },
    "UNAVAILABLE",
  ],
  [
    "changed epoch",
    (f) => {
      f.expected.epoch = 5;
    },
    "UNAVAILABLE",
  ],
  [
    "unknown observation",
    (f) => {
      f.observation = null;
    },
    "UNAVAILABLE",
  ],
  [
    "last fresh millisecond",
    (f) => {
      f.observedNow = 20099;
    },
    null,
  ],
  [
    "invalid monotonic clock",
    (f) => {
      f.observedNow = NaN;
    },
    "UNAVAILABLE",
  ],
  [
    "huge finite clocks",
    (f) => {
      f.observedNow = f.observation!.requestedAt = 1e300;
    },
    "UNAVAILABLE",
  ],
  [
    "infinite clock",
    (f) => {
      f.observedNow = Infinity;
    },
    "UNAVAILABLE",
  ],
  [
    "huge request start",
    (f) => {
      f.observation!.requestedAt = 1e300;
    },
    "UNAVAILABLE",
  ],
  [
    "infinite request start",
    (f) => {
      f.observation!.requestedAt = Infinity;
    },
    "UNAVAILABLE",
  ],
  [
    "NaN request start",
    (f) => {
      f.observation!.requestedAt = NaN;
    },
    "UNAVAILABLE",
  ],
  [
    "fractional clocks",
    (f) => {
      f.observedNow = 101.5;
      f.observation!.requestedAt = 100.25;
    },
    null,
  ],
  [
    "safe clock ceiling",
    (f) => {
      f.observedNow = f.observation!.requestedAt = Number.MAX_SAFE_INTEGER;
    },
    null,
  ],
  [
    "stopped control missing scope",
    (f) => {
      f.observation!.control = {
        incarnation: "history-1",
        epoch: 4,
        stopped: true,
        since: at,
      };
    },
    "UNAVAILABLE",
  ],
  [
    "stopped control missing since",
    (f) => {
      f.observation!.control = {
        incarnation: "history-1",
        epoch: 4,
        stopped: true,
        scope: "issue",
      };
    },
    "UNAVAILABLE",
  ],
  [
    "running control carries scope",
    (f) => {
      f.observation!.control = { ...f.observation!.control, scope: "all" };
    },
    "UNAVAILABLE",
  ],
  [
    "running control carries since",
    (f) => {
      f.observation!.control = { ...f.observation!.control, since: at };
    },
    "UNAVAILABLE",
  ],
];
for (const [name, change, code] of observations) {
  test(
    name,
    () => {
      const f = fixture();
      change(f);
      const result = unchanged(f, () =>
        checkLaneObservation(f.observation, f.expected, f.observedNow),
      );
      expect(result.ok).toBe(code === null);
      if (!result.ok) {
        expect(result.status).toBe("FAIL");
        expect(result.error.code).toBe(code!);
        expect(result).not.toHaveProperty("result.candidate");
      } else expect(result.result).not.toBe(f.observation?.control);
    },
    1000,
  );
}
