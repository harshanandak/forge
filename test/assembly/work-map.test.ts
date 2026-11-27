import { expect, setDefaultTimeout, test } from "bun:test";
import {
  appendWorkMapWarnings,
  readWorkWarnings,
} from "../../src/assembly/work-map.ts";
import { validateResultEnvelope } from "../../src/generated/validators.ts";
import type { ProcessResult } from "../../src/ports/process.ts";

setDefaultTimeout(5000);

type Ports = Parameters<typeof readWorkWarnings>[0];
type Issue = Awaited<ReturnType<Ports["issues"]>>["items"][number];
const candidateId = "work-2";
const incumbentId = "work-1";
const file = "src/ui/ask.rs";
const expiresAt = "2026-11-27T13:30:00.000Z";
const openPull = "https://github.com/owner/project/pull/87";
const config = "schemaVersion: forge.config/1\nblocks: {}\n";

function issue(id: string, fields: Partial<Issue> = {}): Issue {
  return {
    id,
    title:
      id === incumbentId ? "Maintain the Ask editor" : "Add the Ask prompt",
    status: "open",
    dependsOn: [],
    expectedFiles: [file],
    ...fields,
  };
}

function fixture(
  items: readonly Issue[] = [
    issue(incumbentId, { lease: { expiresAt } }),
    issue(candidateId),
  ],
  cwd = "/repo",
) {
  const calls: string[] = [];
  const output: Record<string, string> = {
    "rev-parse": "a".repeat(40) + "\n",
    "ls-tree": `${file}\0`,
    "cat-file": config,
  };
  let issueReads = 0;
  const ports: Ports = {
    now: () => Date.parse("2026-11-27T13:01:00.000Z"),
    issues() {
      issueReads++;
      return { items, truncated: false };
    },
    deliveries: () => ({ items: [], truncated: false }),
    pull: () => ({ state: "CLOSED" }),
    process: {
      resolve: () => ({ kind: "resolved", path: "git" }),
      run: (_git, args, options) => {
        const verb = args[1] ?? "";
        calls.push(options.cwd);
        const stdout = output[verb];
        return Promise.resolve({
          stdout: stdout ?? "",
          stderr: "",
          exitCode: stdout === undefined ? 1 : 0,
          signal: null,
          timedOut: false,
          truncated: false,
          durationMs: 0,
        } satisfies ProcessResult);
      },
    },
  };
  return {
    ports,
    calls,
    output,
    issueReads: () => issueReads,
    read: (branchFor?: (id: string) => string | undefined) =>
      readWorkWarnings(
        ports,
        {
          cwd,
          env: {},
          timeoutMs: 5000,
          defaultRef: "refs/remotes/origin/main",
          candidateId,
        },
        branchFor,
      ),
  };
}

test.each(
  ["/repo", "C:\\workspace\\repo"].flatMap((cwd) =>
    [file, "src/ui/*.rs"].map((pattern) => [cwd, pattern] as const),
  ),
)(
  "format the shared Git path from %s with both issues declaring %s",
  async (cwd, pattern) => {
    const expectedFiles = [pattern];
    const f = fixture(
      [
        issue(incumbentId, { lease: { expiresAt }, expectedFiles }),
        issue(candidateId, { expectedFiles }),
      ],
      cwd,
    );
    const scan = await f.read((id) =>
      id === incumbentId ? "feat/ask" : undefined,
    );
    expect(scan).toEqual({
      warnings: [
        {
          code: "WORK_FILE_OVERLAP",
          message: `"${file}" overlaps work-1 "Maintain the Ask editor" on "feat/ask" (lease until ${expiresAt}). Finish work-1 first, then start work-2.`,
        },
      ],
      omitted: 0,
    });
    expect(f.calls).toEqual([cwd, cwd, cwd]);
  },
);

test("an incumbent dependency overrides the default order", async () => {
  const f = fixture([
    issue(incumbentId, { dependsOn: [candidateId], lease: { expiresAt } }),
    issue(candidateId),
  ]);
  const { warnings } = await f.read();
  expect(warnings[0]?.message ?? "").toContain(
    "Finish work-2 first, then start work-1.",
  );
});

test("the order follows dependencies through an issue without live work", async () => {
  const f = fixture([
    issue(incumbentId, { dependsOn: ["work-3"] }),
    issue("work-3", { dependsOn: [candidateId], expectedFiles: [] }),
    issue(candidateId),
  ]);
  f.ports.deliveries = (id) => ({
    items: id === incumbentId ? [openPull] : [],
    truncated: false,
  });
  f.ports.pull = () => ({ state: "OPEN" });
  const { warnings } = await f.read();
  expect(warnings[0]?.message ?? "").toContain(
    "Finish work-2 first, then start work-1.",
  );
});

test("invalid declarations preserve known overlaps and cannot disable the work budget", async () => {
  const malformed = (value: unknown) =>
    issue("work-3", {
      lease: { expiresAt },
      expectedFiles: value as Issue["expectedFiles"] & readonly string[],
    });
  const found = await fixture([
    issue(incumbentId, { lease: { expiresAt } }),
    malformed({}),
    issue(candidateId),
  ]).read();
  const expensive = fixture([
    malformed([42]),
    issue(candidateId, { expectedFiles: ["src/" + "?".repeat(1000)] }),
  ]);
  expensive.output["ls-tree"] =
    Array.from({ length: 1000 }, (_, n) => `src/${n}`.padEnd(100, "x")).join(
      "\0",
    ) + "\0";
  const bounded = await expensive.read();
  expect({
    known: found.warnings.map(({ code }) => code),
    invalidReported: found.warnings.some(({ message }) =>
      message.includes("invalid-declarations"),
    ),
    budgetReported: bounded.warnings.some(({ message }) =>
      message.includes("resolution-budget"),
    ),
    matchedBeyondBudget: bounded.warnings.some(({ message }) =>
      message.includes("unmatched-pattern"),
    ),
  }).toEqual({
    known: ["WORK_FILE_MAP_INCOMPLETE", "WORK_FILE_OVERLAP"],
    invalidReported: true,
    budgetReported: true,
    matchedBeyondBudget: false,
  });
});

test("the full overlap message remains bounded with an oversized issue ID", async () => {
  const f = fixture([
    issue("x".repeat(1000), { lease: { expiresAt } }),
    issue(candidateId),
  ]);
  const { warnings } = await f.read();
  const overlap = warnings.find(({ code }) => code === "WORK_FILE_OVERLAP");
  expect(overlap?.message.length).toBeLessThanOrEqual(2000);
  expect(overlap?.message ?? "").toContain(file);
  expect(overlap?.message ?? "").toContain("then start work-2.");
});

test("an open linked pull supplies the branch and evidence after lease release", async () => {
  const f = fixture([
    issue(incumbentId, {
      lease: { expiresAt, releasedAt: "2026-11-27T13:00:00.000Z" },
    }),
    issue(candidateId),
  ]);
  f.ports.deliveries = (id) => ({
    items: id === incumbentId ? [openPull] : [],
    truncated: false,
  });
  f.ports.pull = () => ({ state: "OPEN", branch: "feat/released" });
  const { warnings } = await f.read();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.message ?? "").toContain(
    `on "feat/released" (open PR "${openPull}")`,
  );
});

test("a replay ignores its own issue but another issue held by the same session still overlaps", async () => {
  const grant = {
    expiresAt,
    holder: {
      actor: { kind: "agent", id: "builder" },
      session: { id: "session", device: "device" },
    },
  };
  const candidate = issue(candidateId, { lease: grant });
  const incumbent = issue(incumbentId, { lease: grant });
  expect((await fixture([candidate]).read()).warnings).toEqual([]);
  const { warnings } = await fixture([candidate, incumbent]).read();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.message ?? "").toContain(`overlaps ${incumbentId}`);
});

test("disjoint and generated paths leave the advisory empty", async () => {
  const incumbent = issue(incumbentId, {
    lease: { expiresAt },
    expectedFiles: [file, "generated/output.json"],
  });
  const candidate = issue(candidateId, {
    expectedFiles: ["src/ui/other.rs", "generated/output.json"],
  });
  const f = fixture([incumbent, candidate]);
  f.output["cat-file"] = JSON.stringify({
    schemaVersion: "forge.config/1",
    blocks: {
      work: {
        source: { builtin: "forge/work" },
        config: {
          generatedFiles: [
            { glob: "generated/**", regenerate: { argv: ["generate"] } },
          ],
        },
      },
    },
  });
  expect(await f.read()).toEqual({ warnings: [], omitted: 0 });
});

test("the envelope reserves a final row and reports the exact number of omitted warnings", async () => {
  const paths = Array.from({ length: 34 }, (_, i) => `src/${i}.rs`);
  const f = fixture([
    issue(incumbentId, { lease: { expiresAt }, expectedFiles: paths }),
    issue(candidateId, { expectedFiles: paths }),
  ]);
  const existing = { code: "OTHER", message: "Existing warning." };
  const warnings = appendWorkMapWarnings([existing], await f.read());
  expect(warnings).toHaveLength(32);
  expect(warnings[0]).toEqual(existing);
  expect(
    warnings.filter(({ code }) => code === "WORK_FILE_OVERLAP"),
  ).toHaveLength(30);
  expect(warnings.at(-1)).toEqual({
    code: "WORK_FILE_MAP_TRUNCATED",
    message: "4 warning rows omitted at the envelope limit.",
  });
  expect(
    validateResultEnvelope({
      ok: true,
      op: "issue.claim",
      status: "OK",
      result: {},
      warnings,
    }).ok,
  ).toBe(true);
});

test("escaped text stays in a single bounded warning and preserves the order", async () => {
  const path = "src/" + "🧭".repeat(1020);
  const f = fixture([
    issue(incumbentId, {
      expectedFiles: [path],
      lease: { expiresAt },
      title: "Untrusted\n" + "x".repeat(400),
    }),
    issue(candidateId, { expectedFiles: [path] }),
  ]);
  const { warnings } = await f.read();
  expect(warnings).toHaveLength(1);
  const message = warnings[0]?.message ?? "";
  expect(message.length).toBeLessThanOrEqual(2000);
  expect(message).toContain('…" overlaps work-1');
  expect(message).toContain("Untrusted\\u000a");
  expect(message).not.toContain("\n");
  expect(message).toEndWith("Finish work-1 first, then start work-2.");
});

test("unknown generated policy leaves an incomplete warning without reading issue authority", async () => {
  const f = fixture();
  delete f.output["cat-file"];
  const { warnings } = await f.read();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.code).toBe("WORK_FILE_MAP_INCOMPLETE");
  expect(warnings[0]?.message ?? "").toContain("policy-unreadable");
  expect(f.issueReads()).toBe(0);
});

test("an unmatched candidate glob is reported even before it has a lease", async () => {
  const f = fixture([
    issue(candidateId, { expectedFiles: ["missing/**/*.rs"] }),
  ]);
  const { warnings } = await f.read();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.code).toBe("WORK_FILE_MAP_INCOMPLETE");
  expect(warnings[0]?.message ?? "").toContain("unmatched-pattern");
});

test("incomplete evidence remains visible even if the envelope was already full", async () => {
  const f = fixture();
  const items = [
    issue(candidateId),
    issue(incumbentId, { lease: { expiresAt } }),
  ];
  f.ports.issues = () => ({ items, truncated: true });
  const scan = await f.read();
  expect(scan.warnings.map(({ code }) => code)).toEqual([
    "WORK_FILE_MAP_INCOMPLETE",
    "WORK_FILE_OVERLAP",
  ]);
  const existing = Array.from({ length: 32 }, () => ({
    code: "OTHER",
    message: "Existing warning.",
  }));
  const warnings = appendWorkMapWarnings(existing, scan);
  expect(warnings).toHaveLength(32);
  expect(warnings[0]?.message ?? "").toContain("issues-truncated");
  expect(warnings.at(-1)?.message).toBe(
    "3 warning rows omitted at the envelope limit.",
  );
});
