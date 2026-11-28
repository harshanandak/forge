import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { WindowsSecurityReader } from "../../src/contract/windows-security.ts";
import {
  createPathProtection,
  UnverifiedDirectoryCreation,
} from "../../src/core/protect.ts";
import {
  decodeWindowsDescriptor,
  readSid,
} from "../../src/core/windows-security-read.ts";
import {
  creationFixtures,
  type CreationRecipe,
  type CreationSide,
} from "./protect-windows-native-fixture.ts";
import { frozenDirectoryOutcome } from "./protect-windows-reference.ts";

type Creator = WindowsSecurityReader & {
  isDirectory(path: string): boolean;
  createDirectory(path: string, descriptor: Buffer): boolean;
  move(source: string, target: string): boolean;
  removeDirectory(path: string): boolean;
};
type Clock = { end: number; now: () => number };
type Owned = <T>(
  status: number,
  handle: unknown,
  close: (handle: unknown) => unknown,
  use: (handle: unknown) => T,
) => T;
type Outcome = boolean | "unverified";
type Hook = (creator: Creator) => Creator;

const library = new URL(
  "../../src/core/windows-security-create.ts",
  import.meta.url,
);
const missing = (..._args: unknown[]): never => "missing" as never;
const { createPrivateWindowsDirectory = missing, privateDescriptor = missing } =
  (existsSync(library) ? await import(library.href) : {}) as {
    createPrivateWindowsDirectory?: (
      native: Creator,
      target: string,
      clock: Clock,
    ) => string;
    privateDescriptor?: (sid: Buffer, directory: boolean) => Buffer;
  };
const { withOwnedHandle = missing, windowsDirectoryCreator } =
  (await import("../../src/adapters/windows-security.ts")) as {
    withOwnedHandle?: Owned;
    windowsDirectoryCreator?: () => Promise<Creator>;
  };
const budget = 5_000;
const timeout = 10_000;
const covered = new Set<string>();

afterAll(() => {
  console.log(`COVERED ${covered.size} OF 8: ${[...covered].sort().join(",")}`);
});

function outcome(run: () => string): Outcome {
  try {
    const result = run();
    return result === "published_unverified"
      ? "unverified"
      : result === "private";
  } catch {
    return false;
  }
}

async function candidate() {
  let launches = 0;
  if (!windowsDirectoryCreator) {
    const guard = createPathProtection({
      execute(file, args, options) {
        if (/powershell\.exe$/i.test(file)) launches++;
        return spawnSync(file, args, options);
      },
    });
    return {
      native: false,
      launches: () => launches,
      async create(target: string, _hook: Hook): Promise<Outcome> {
        try {
          return await guard.createPrivateDirectory(target);
        } catch (error) {
          return error instanceof UnverifiedDirectoryCreation && "unverified";
        }
      },
    };
  }
  const creator = await windowsDirectoryCreator();
  return {
    native: true,
    launches: () => launches,
    create: (target: string, hook: Hook) =>
      Promise.resolve(
        outcome(() =>
          createPrivateWindowsDirectory(hook(creator), target, {
            end: Date.now() + budget,
            now: Date.now,
          }),
        ),
      ),
  };
}

function hooked(
  fixture: ReturnType<typeof creationFixtures>,
  side: CreationSide,
  { fault }: CreationRecipe,
): Hook {
  return (creator) => {
    let staging = "";
    const barrier = (name: string, path: string) => {
      if (fault?.barrier === name) fixture.fault(fault, path, side.log);
    };
    return {
      user: () => creator.user(),
      read(path, directory) {
        if (path === staging && fault?.action === "unreadable")
          throw new Error("Injected staging read failure");
        return creator.read(path, directory);
      },
      isDirectory: (path) => creator.isDirectory(path),
      createDirectory(path, descriptor) {
        const made = creator.createDirectory(path, descriptor);
        if (made) barrier("staged", (staging = path));
        return made;
      },
      move(source, target) {
        const moved = creator.move(source, target);
        if (moved) barrier("published", target);
        return moved;
      },
      removeDirectory: (path) => creator.removeDirectory(path),
    };
  };
}

test.skipIf(process.platform !== "win32")(
  "row 44 publishes a private directory like the frozen reference without ACL PowerShell",
  async () => {
    const recipe: CreationRecipe = {
      row: "44",
      variant: "staging observed, then published",
      expected: true,
      fault: { barrier: "staged", action: "observe" },
    };
    const fixture = creationFixtures([recipe]);
    try {
      const run = await candidate();
      const { reference, candidate: side } = fixture.cases[0]!;
      const expected = fixture.reference(reference, recipe.fault);
      const started = performance.now();
      const actual = await run.create(
        side.target,
        hooked(fixture, side, recipe),
      );
      const elapsed = performance.now() - started;
      const [referenceState, candidateState] = fixture.snapshot()[0]!;
      const lines = (state: string) => state.split("\n");
      console.log(
        JSON.stringify({
          row: recipe.row,
          expected,
          actual,
          elapsed,
          launches: run.launches(),
          native: run.native,
          referenceState,
          candidateState,
        }),
      );
      expect([expected, actual]).toEqual([true, true]);
      expect(lines(candidateState!).slice(0, -1)).toEqual(
        lines(referenceState!).slice(0, -1),
      );
      expect(lines(candidateState!)[0]).toMatch(
        /^target {2}O:@G:S-[\d-]+D:P(AI)?\(A;OICI;FA;;;@\)$/,
      );
      expect(run.launches()).toBe(0);
      expect(run.native).toBe(true);
      expect(elapsed).toBeLessThan(budget);
      expect(candidateState).toBe(referenceState);
      expect(lines(candidateState!).at(-1)).toMatch(
        /^staged O:@D:P(AI)?\(A;OICI;FA;;;@\)$/,
      );
      covered.add(recipe.row);
    } finally {
      fixture.close();
    }
  },
  60_000,
);

const staged = (variant: string, sddl: string): CreationRecipe => ({
  row: "40",
  variant,
  expected: false,
  fault: { barrier: "staged", sddl },
});
const published = (
  variant: string,
  fault: Omit<NonNullable<CreationRecipe["fault"]>, "barrier">,
): CreationRecipe => ({
  row: "43",
  variant,
  expected: "unverified",
  fault: { barrier: "published", ...fault },
});
const matrix: CreationRecipe[] = [
  { row: "38", variant: "missing parent", expected: false, parent: "missing" },
  { row: "38", variant: "parent is a file", expected: false, parent: "file" },
  {
    row: "39",
    variant: "parent denies create",
    expected: false,
    parentSddl: "O:@D:P(A;;0x1200a9;;;@)",
  },
  staged("foreign owner", "O:BAD:P(A;OICI;FA;;;@)"),
  staged("unprotected DACL", "O:@D:(A;OICI;FA;;;@)"),
  staged("deny ACE", "O:@D:P(D;OICI;FA;;;@)"),
  staged("other SID", "O:@D:P(A;OICI;FA;;;BA)"),
  staged("no ACE", "O:@D:P"),
  staged("no inheritance flags", "O:@D:P(A;;FA;;;@)"),
  staged("read-only mask", "O:@D:P(A;OICI;0x1200a9;;;@)"),
  {
    row: "40",
    variant: "staging read failure",
    expected: false,
    fault: { barrier: "staged", action: "unreadable" },
  },
  ...(["file", "dir", "full", "junction", "symlink"] as const).map(
    (shape): CreationRecipe => ({
      row: "41",
      variant: `existing ${shape}`,
      expected: false,
      shape,
    }),
  ),
  {
    row: "42",
    variant: "move refused, staging nonempty",
    expected: false,
    shape: "file",
    fault: { barrier: "staged", action: "fill" },
  },
  published("target deleted", { action: "delete" }),
  published("target replaced", { action: "replace" }),
  published("target ACL widened", {
    sddl: "O:@D:P(A;OICI;FA;;;@)(A;OICI;FA;;;BA)",
  }),
  ...[
    "it's $(x) & y;",
    "ünïcødé-日本",
    "line\nbreak",
    "pipe|name",
    "nul\0name",
  ].map((name): CreationRecipe => ({
    row: "86",
    variant: JSON.stringify(name),
    expected: !/[\n|\0]/.test(name),
    name,
  })),
];

test.skipIf(process.platform !== "win32")(
  "rows 38-43 and path transport match the frozen reference on real NTFS objects",
  async () => {
    const fixture = creationFixtures(matrix);
    try {
      const run = await candidate();
      const results = [];
      for (const { recipe, reference, candidate: side } of fixture.cases) {
        const expected = fixture.reference(reference, recipe.fault);
        const launched = run.launches();
        const started = performance.now();
        const actual = await run.create(
          side.target,
          hooked(fixture, side, recipe),
        );
        const elapsed = performance.now() - started;
        const launches = run.launches() - launched;
        console.log(
          JSON.stringify({ ...recipe, actual, expected, elapsed, launches }),
        );
        results.push({ expected, actual, elapsed, launches });
      }
      const states = fixture.snapshot();
      const entries = (state: string) => state.split("\n").slice(0, -1);
      for (const [index, { recipe }] of fixture.cases.entries()) {
        const [referenceState, candidateState] = states[index]!;
        const { expected, actual, elapsed, launches } = results[index]!;
        console.log(JSON.stringify({ referenceState, candidateState }));
        expect([recipe.variant, expected, actual, launches]).toEqual([
          recipe.variant,
          recipe.expected,
          recipe.expected,
          0,
        ]);
        expect(candidateState).toBe(referenceState);
        expect(elapsed).toBeLessThan(budget);
        const observed = candidateState!
          .split("\n")
          .at(-1)!
          .replace(/(D:P?)AI/, "$1");
        if (recipe.row === "40")
          expect(observed).toBe(
            `staged ${recipe.fault?.sddl ?? "O:@D:P(A;OICI;FA;;;@)"}`,
          );
        if (recipe.expected === false && recipe.row !== "42")
          expect(entries(candidateState!)).toEqual(
            entries(fixture.before[index]![1]!),
          );
      }
      const rows = [...new Set(matrix.map(({ row }) => row))];
      expect(rows).toEqual(["38", "39", "40", "41", "42", "43", "86"]);
      for (const row of rows.slice(0, -1)) covered.add(row);
      console.log(`HOSTED ROWS 38-43 AND 86: ${matrix.length} cases`);
    } finally {
      fixture.close();
    }
  },
  120_000,
);

const sid = Buffer.from([
  1, 5, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0xe9,
  3, 0, 0,
]);
type Phase = "exists" | "create" | "staging" | "move" | "target" | "remove";
type Faults = Partial<Record<Phase, "fail" | "throw">>;

function fake(faults: Faults, clock = { now: 0, step: 0 }, user = sid) {
  const calls: Phase[] = [];
  const act = (phase: Phase) => {
    calls.push(phase);
    clock.now += clock.step;
    if (faults[phase] === "throw") throw new Error(`Injected ${phase}`);
    return faults[phase] !== "fail";
  };
  const native: Creator = {
    user: () => user,
    read(path) {
      if (!act(win32.basename(path) === "target" ? "target" : "staging"))
        throw new Error("Injected read failure");
      return privateDescriptor(sid, true);
    },
    isDirectory: () => act("exists"),
    createDirectory: () => act("create"),
    move: () => act("move"),
    removeDirectory: () => act("remove"),
  };
  const run = (end = 100, target = "C:\\parent\\target") =>
    createPrivateWindowsDirectory(native, target, {
      end,
      now: () => clock.now,
    });
  return { calls, run };
}

test(
  "the creation descriptor is owner-only, protected, groupless and full control",
  () => {
    const user = readSid(sid, 0, sid.length).sid;
    for (const directory of [true, false]) {
      const bytes = privateDescriptor(sid, directory);
      expect(bytes).toBeInstanceOf(Buffer);
      const { owner, protectedDacl, dacl } = decodeWindowsDescriptor(bytes);
      expect([
        owner,
        bytes.readUInt32LE(8),
        protectedDacl,
        dacl?.map(({ type, flags, mask, sid }) => [type, flags, mask, sid]),
      ]).toEqual([user, 0, true, [[0, directory ? 3 : 0, 0x1f01ff, user]]]);
    }
    expect(() => privateDescriptor(Buffer.alloc(8), true)).toThrow(
      "Invalid Windows security descriptor",
    );
  },
  timeout,
);

const stages = ["exists", "create", "staging", "move"] as const;
test.each([
  ["38 parent missing", { exists: "fail" }, "refused", ["exists"]],
  [
    "39 CreateDirectoryW fails",
    { create: "fail" },
    "refused",
    stages.slice(0, 2),
  ],
  [
    "40 staging not private",
    { staging: "fail" },
    "refused",
    [...stages.slice(0, 3), "remove"],
  ],
  ["41 move refused", { move: "fail" }, "refused", [...stages, "remove"]],
  [
    "42 cleanup fails",
    { move: "fail", remove: "fail" },
    "refused",
    [...stages, "remove"],
  ],
  [
    "43 final check fails",
    { target: "fail" },
    "published_unverified",
    [...stages, "target"],
  ],
  ["44 verified", {}, "private", [...stages, "target"]],
] as const)(
  "row %s",
  (row, faults: Faults, result, calls) => {
    const { run, calls: seen } = fake(faults);
    expect([run(), seen]).toEqual([result, [...calls]]);
    covered.add(row.slice(0, 2));
  },
  timeout,
);

test(
  "row 45 escaping exceptions map to false and only clean publication throws the class",
  async () => {
    const escaping: Faults[] = [
      { exists: "throw" },
      { create: "throw" },
      { move: "throw" },
      { move: "fail", remove: "throw" },
    ];
    for (const faults of escaping) {
      const { run, calls } = fake(faults);
      expect(() => run()).toThrow("Injected");
      expect(outcome(run)).toBe(false);
      expect(calls).not.toContain("target");
    }
    const malformed = fake({}, undefined, Buffer.alloc(8));
    expect(outcome(malformed.run)).toBe(false);
    expect(malformed.calls).toEqual(["exists"]);
    expect(outcome(fake({ target: "throw" }).run)).toBe("unverified");
    const guard = createPathProtection({ platform: "win32" });
    await expect(
      guard.createPrivateDirectory(1 as unknown as string),
    ).rejects.toThrow(TypeError);
    covered.add("45");
  },
  timeout,
);

test(
  "one absolute end refuses before each mutation and accepts late clean completion",
  () => {
    for (const end of [0, -1]) {
      const { run, calls } = fake({});
      expect([run(end), calls]).toEqual(["refused", []]);
    }
    const cases = [
      [100, "refused", ["exists"]],
      [40, "refused", [...stages.slice(0, 3), "remove"]],
      [30, "private", [...stages, "target"]],
    ] as const;
    for (const [step, result, calls] of cases) {
      const { run, calls: seen } = fake({}, { now: 0, step });
      expect([run(), seen]).toEqual([result, [...calls]]);
    }
  },
  timeout,
);

test(
  "NUL and root targets refuse before native calls; a failure does not poison the next request",
  () => {
    const faults: Faults = { create: "fail" };
    const { run, calls } = fake(faults);
    expect([run(100, "C:\\parent\\a\0b"), run(100, "C:\\"), calls]).toEqual([
      "refused",
      "refused",
      [],
    ]);
    expect(run()).toBe("refused");
    delete faults.create;
    expect(run()).toBe("private");
  },
  timeout,
);

test.each([
  ["zero status with a handle", 0, "handle", 1, 1],
  ["nonzero completed success with an owned handle", 0x108, "handle", 0, 1],
  ["zero status with missing output", 0, null, 0, 0],
  ["pending status", 0x103, "handle", 0, 0],
  ["warning status", 0x80000005 | 0, "handle", 0, 0],
  ["failure status", 0xc0000034 | 0, "output", 0, 0],
] as const)(
  "forge-2114 %s closes only an owned handle, once",
  (_, status, handle, uses, closes) => {
    let used = 0;
    let closed = 0;
    const open = () =>
      withOwnedHandle(
        status,
        handle,
        () => closed++,
        () => ++used,
      );
    if (uses) expect(open()).toBe(1);
    else expect(open).toThrow(/Windows open status|Cannot open Windows path/);
    expect([used, closed]).toEqual([uses, closes]);
    expect(() =>
      withOwnedHandle(
        0,
        "handle",
        () => closed++,
        () => {
          throw new Error("read failed");
        },
      ),
    ).toThrow("read failed");
    expect(closed).toBe(closes + 1);
  },
  timeout,
);

test(
  "frozen marker parsing refuses failed or unknown completions and keeps late clean ones",
  () => {
    const run = (
      status: number | null,
      stdout: string,
      stderr = "",
      error?: Error,
    ) => frozenDirectoryOutcome({ status, stdout, stderr, error });
    expect([
      run(0, "private\r\n"),
      run(0, "published_unverified\n"),
      run(null, "published_unverified\n", "", new Error("ETIMEDOUT")),
      run(1, ""),
      run(0, ""),
      run(0, "private extra"),
      run(0, "private", "warning"),
    ]).toEqual([true, "unverified", false, false, false, false, false]);
  },
  timeout,
);
