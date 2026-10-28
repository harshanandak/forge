import { expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const helpers = resolve(
  import.meta.dirname,
  "../../../templates/delivery/skills/forge-review",
);
const branchBin = resolve(import.meta.dirname, "../../../dist/bin/forge.js");
const thread = (id: string, isResolved = false) => ({
  id,
  isResolved,
  path: "src/example.ts",
  line: 7,
  comments: {
    nodes: [
      {
        fullDatabaseId: "42",
        path: "src/example.ts",
        line: 7,
        author: { login: "reviewer" },
        body: "x".repeat(210),
      },
    ],
  },
});
type Page = {
  nodes: unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};
type Call = {
  args: string[];
  payload: {
    query?: string;
    variables?: Record<string, unknown>;
    body?: string;
  };
};

function fixture(
  run: (
    root: string,
    invoke: (script: string, args?: string[]) => SpawnSyncReturns<string>,
    calls: () => Call[],
    cli: (args: string[]) => SpawnSyncReturns<string>,
  ) => void,
  options: { pages?: Page[]; failure?: string; stateful?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-review-helpers-"));
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required");
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(name),
    ),
  );
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: root,
    GH_CONFIG_DIR: root,
    GH_TEST_ROOT: root,
    GH_TOKEN: "not-a-real-token",
    FORGE_DEVICE_ROOT: join(root, "device"),
  });
  const preload = join(root, "preload.mjs");
  try {
    writeFileSync(join(root, "scenario.json"), JSON.stringify(options));
    writeFileSync(join(root, "calls.jsonl"), "");
    // Redirect only gh; the helper still launches a real subprocess with the original argv and stdin.
    writeFileSync(
      preload,
      `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command !== 'gh') throw new Error('unexpected executable');
  if (options?.shell) throw new Error('shell execution forbidden');
  if (!options?.env) throw new Error('explicit environment required');
  return original(process.execPath, [join(process.env.GH_TEST_ROOT, 'gh.mjs'), ...args], options);
};
syncBuiltinESMExports();
`,
    );
    writeFileSync(
      join(root, "gh.mjs"),
      `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.GH_TEST_ROOT;
const scenario = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8'));
const args = process.argv.slice(2);
const payload = JSON.parse(readFileSync(args[args.indexOf('--input') + 1] === '-' ? 0 : args[args.indexOf('--input') + 1], 'utf8'));
const previous = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\\n').filter(Boolean);
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ args, payload }) + '\\n');
const resolving = payload.query?.includes('resolveReviewThread');
const listing = payload.query?.includes('reviewThreads');
const stateFile = join(root, 'resolved.json');
const resolved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : [];
if (scenario.failure === 'transport' || (resolving && scenario.failure === 'resolve-transport')) {
  process.stderr.write((resolving ? 'resolve transport refused' : 'reply transport refused') + ' ' + process.env.GH_TOKEN + String.fromCharCode(10));
  process.exit(1);
}
let response;
if (listing) {
  const page = scenario.pages?.[scenario.stateful ? 0 : previous.length];
  if (scenario.stateful && page) page.nodes = page.nodes.map(node => node && resolved.includes(node.id) ? { ...node, isResolved: true } : node);
  response = { data: { repository: { pullRequest: { reviewThreads: page } } } };
  if (scenario.failure === 'graphql' || (scenario.failure === 'last-page-errors' && previous.length)) response.errors = [{ message: 'refused' }];
} else if (resolving) {
  response = { data: { resolveReviewThread: { thread: { isResolved: scenario.failure !== 'unresolved' } } } };
  if (scenario.failure === 'resolve-graphql') response.errors = [{ message: 'refused' }];
  if (scenario.stateful && !response.errors && response.data.resolveReviewThread.thread.isResolved === true && scenario.failure !== 'invalid-json') {
    if (!scenario.pages?.some(page => page.nodes.some(node => node?.id === payload.variables.thread))) throw new Error('unknown thread');
    writeFileSync(stateFile, JSON.stringify([...resolved, payload.variables.thread]));
  }
} else response = scenario.failure === 'reply-invalid' ? {} : { id: 99 };
process.stdout.write(scenario.failure === 'invalid-json' ? '{' : JSON.stringify(response));
`,
    );
    const invoke = (script: string, args = ["owner", "repo", "123"]) =>
      spawnSync(
        node,
        [
          "--import",
          pathToFileURL(preload).href,
          join(helpers, script),
          ...args,
        ],
        {
          cwd: root,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        },
      );
    const calls = () =>
      readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call);
    const cli = (args: string[]) =>
      spawnSync(node, [branchBin, ...args], {
        cwd: root,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
    run(root, invoke, calls, cli);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("list helper follows all pages and emits only unresolved first comments", () => {
  fixture(
    (_root, invoke, calls) => {
      const result = invoke("list-threads.mjs");
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown),
      ).toEqual([
        {
          id: "open-one",
          commentId: "42",
          path: "src/example.ts",
          line: 7,
          author: "reviewer",
          body: "x".repeat(200),
        },
        {
          id: "open-two",
          commentId: "42",
          path: "src/example.ts",
          line: 7,
          author: "reviewer",
          body: "x".repeat(200),
        },
      ]);
      const requests = calls();
      expect(requests).toHaveLength(2);
      expect(requests[0]?.payload.variables).toEqual({
        owner: "owner",
        repo: "repo",
        pr: 123,
        cursor: null,
      });
      expect(requests[1]?.payload.variables?.cursor).toBe("page-two");
      expect(requests[0]?.payload.query).toContain("reviewThreads(first:100");
      expect(requests[0]?.payload.query).toContain("comments(first:1");
    },
    {
      pages: [
        {
          nodes: [thread("closed", true), thread("open-one")],
          pageInfo: { hasNextPage: true, endCursor: "page-two" },
        },
        {
          nodes: [thread("open-two")],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      ],
    },
  );
}, 30_000);

test.each(["2787717459", "9007199254740993"])(
  "R1-1 preserves full comment id %s as a decimal string",
  (id) => {
    const node = thread("large-id");
    fixture(
      (_root, invoke, calls) => {
        const result = invoke("list-threads.mjs");
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ commentId: id });
        expect(calls()[0]?.payload.query).toContain("fullDatabaseId");
        expect(calls()[0]?.payload.query).not.toContain("{databaseId");
      },
      {
        pages: [
          {
            nodes: [
              {
                ...node,
                comments: {
                  nodes: [
                    {
                      ...node.comments.nodes[0],
                      databaseId: null,
                      fullDatabaseId: id,
                    },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        ],
      },
    );
  },
  30_000,
);

test.each(["transport", "resolve-transport"])(
  "R1-2 identifies the failed mutation on %s",
  (failure) => {
    fixture(
      (root, invoke, calls) => {
        const file = join(root, "reply.txt");
        writeFileSync(file, "reply");
        const result = invoke("reply-and-resolve.mjs", [
          "owner",
          "repo",
          "123",
          "2787717459",
          "thread",
          file,
        ]);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          failure === "transport"
            ? "reply transport refused"
            : "resolve transport refused",
        );
        expect(result.stderr).not.toContain("not-a-real-token");
        expect(result.stderr).toContain("[redacted]");
        if (failure === "transport") {
          expect(result.stderr).not.toContain("posted");
          expect(calls()).toHaveLength(1);
        } else {
          expect(result.stderr).toContain("reply 99 posted; resolve failed");
          expect(calls()).toHaveLength(2);
        }
      },
      { failure },
    );
  },
  30_000,
);

test("list helper rejects a null thread node without emitting partial pages", () => {
  fixture(
    (_root, invoke) => {
      const result = invoke("list-threads.mjs");
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Incomplete review-thread response");
      expect(result.stderr).toMatch(/rerun/i);
    },
    {
      pages: [
        {
          nodes: [thread("before")],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
        {
          nodes: [null, thread("after")],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      ],
    },
  );
}, 30_000);

test("R1-5 maps thread locations and missing comments without splitting emoji", () => {
  const node = thread("unicode");
  fixture(
    (_root, invoke) => {
      const result = invoke("list-threads.mjs");
      expect(result.status, result.stderr).toBe(0);
      expect(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown),
      ).toEqual([
        {
          id: "unicode",
          commentId: "2787717459",
          path: "thread.ts",
          line: 19,
          author: "reviewer",
          body: "🌿".repeat(200),
        },
        {
          id: "empty",
          commentId: null,
          path: null,
          line: null,
          author: null,
          body: "",
        },
      ]);
    },
    {
      pages: [
        {
          nodes: [
            {
              ...node,
              path: "thread.ts",
              line: 19,
              comments: {
                nodes: [
                  {
                    ...node.comments.nodes[0],
                    fullDatabaseId: "2787717459",
                    body: "🌿".repeat(201),
                  },
                ],
              },
            },
            { id: "empty", isResolved: false, comments: { nodes: [] } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      ],
    },
  );
}, 30_000);

test.each([
  "transport",
  "graphql",
  "invalid-json",
  "missing-page",
  "missing-cursor",
])(
  "list helper fails closed on %s",
  (failure) => {
    const page = {
      nodes: [],
      pageInfo: {
        hasNextPage: true,
        endCursor: failure === "missing-cursor" ? null : "same",
      },
    };
    fixture(
      (_root, invoke) => {
        const result = invoke("list-threads.mjs");
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
      },
      { failure, pages: failure === "missing-page" ? [] : [page, page] },
    );
  },
  30_000,
);

test("list helper does not emit partial pages when a later query fails", () => {
  fixture(
    (_root, invoke, calls) => {
      const result = invoke("list-threads.mjs");
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(calls()).toHaveLength(2);
    },
    {
      failure: "last-page-errors",
      pages: [
        {
          nodes: [thread("open")],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
        { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      ],
    },
  );
}, 30_000);

test("list helper permits deleted authors and outdated lines, including an empty page", () => {
  const outdated = thread("outdated");
  const comment = outdated.comments.nodes[0]!;
  const node = {
    ...outdated,
    line: null,
    comments: { nodes: [{ ...comment, author: null, line: null }] },
  };
  fixture(
    (_root, invoke) => {
      const result = invoke("list-threads.mjs");
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        author: null,
        line: null,
      });
    },
    {
      pages: [
        {
          nodes: [node],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      ],
    },
  );
  fixture(
    (_root, invoke) => {
      const result = invoke("list-threads.mjs");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    },
    {
      pages: [{ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }],
    },
  );
}, 30_000);

test("invalid arguments and unreadable reply files make no GitHub calls", () => {
  fixture((root, invoke, calls) => {
    expect(invoke("list-threads.mjs", []).status).not.toBe(0);
    for (const args of [
      [],
      [""],
      ["owner", "repo"],
      ["owner", "repo", "123", "null", "thread", "reply.txt"],
      ["owner", "repo", "123", "42", "thread", "reply.txt", "extra"],
    ])
      expect(invoke("reply-and-resolve.mjs", args).status).not.toBe(0);
    expect(
      invoke("reply-and-resolve.mjs", [
        "owner",
        "repo",
        "123",
        "42",
        "thread",
        join(root, "missing.txt"),
      ]).status,
    ).not.toBe(0);
    expect(calls()).toHaveLength(0);
  });
}, 30_000);

test("reply helper preserves file bytes in JSON stdin and resolves only after posting", () => {
  fixture((root, invoke, calls) => {
    const body =
      "$(touch injected) 'single' \"double\" \\ slash\nsecond line\r\nUnicode: café 🌿\n";
    const path = join(root, "reply with spaces.txt");
    writeFileSync(path, body);
    const result = invoke("reply-and-resolve.mjs", [
      "owner",
      "repo",
      "123",
      "42",
      "thread-one",
      path,
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("true");
    const requests = calls();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.args).toEqual([
      "api",
      "--method",
      "POST",
      "repos/owner/repo/pulls/123/comments/42/replies",
      "--input",
      "-",
    ]);
    expect(Buffer.from(requests[0]?.payload.body ?? "")).toEqual(
      readFileSync(path),
    );
    expect(requests[1]?.payload.query).toContain("resolveReviewThread");
    expect(requests[1]?.payload.variables).toEqual({ thread: "thread-one" });
  });
}, 30_000);

test("filing a commentless thread then resolving it clears the unresolved list", () => {
  fixture(
    (root, invoke, calls, cli) => {
      mkdirSync(join(root, ".forge"));
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "review-thread-fixture", version: "1.0.0" }),
      );
      writeFileSync(
        join(root, ".forge/config.yaml"),
        JSON.stringify({
          schemaVersion: "forge.config/1",
          blocks: { work: { source: { builtin: "forge/work" } } },
        }),
      );
      const initial = invoke("list-threads.mjs");
      expect(initial.status, initial.stderr).toBe(0);
      expect(JSON.parse(initial.stdout)).toMatchObject({
        id: "no-comment",
        commentId: null,
      });
      const filed = cli([
        "issue",
        "create",
        "--input",
        JSON.stringify({
          title: "Review thread without a first comment",
          kind: "task",
          body: "Track PR 123 thread no-comment before resolving it.",
        }),
      ]);
      expect(filed.error).toBeUndefined();
      expect(filed.status, filed.stdout + filed.stderr).toBe(0);
      const issue = (JSON.parse(filed.stdout) as { result: { id: string } })
        .result;
      expect(issue.id).toBeString();
      const shown = cli(["issue", "show", issue.id]);
      expect(shown.status, shown.stdout + shown.stderr).toBe(0);
      const saved = JSON.parse(shown.stdout) as {
        result: { id: string; body: string };
      };
      expect(saved.result.id).toBe(issue.id);
      expect(saved.result.body).toContain("no-comment");
      const afterFiling = invoke("list-threads.mjs");
      expect(afterFiling.status, afterFiling.stderr).toBe(0);
      expect(afterFiling.stdout).toBe(initial.stdout);
      const resolved = invoke("reply-and-resolve.mjs", ["no-comment"]);
      expect(resolved.status, resolved.stderr).toBe(0);
      expect(resolved.stdout.trim()).toBe("true");
      const afterResolving = invoke("list-threads.mjs");
      expect(afterResolving.status, afterResolving.stderr).toBe(0);
      expect(afterResolving.stdout).toBe("");
      const requests = calls();
      expect(requests).toHaveLength(4);
      expect(requests.every((request) => request.args[1] === "graphql")).toBe(
        true,
      );
      expect(requests[2]?.payload.query).toContain("resolveReviewThread");
      expect(requests[2]?.payload.variables).toEqual({ thread: "no-comment" });
    },
    {
      stateful: true,
      pages: [
        {
          nodes: [
            { id: "no-comment", isResolved: false, comments: { nodes: [] } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      ],
    },
  );
}, 60_000);

test.each([
  "resolve-transport",
  "resolve-graphql",
  "unresolved",
  "invalid-json",
])(
  "resolve-only helper never reports success on %s",
  (failure) => {
    fixture(
      (_root, invoke, calls) => {
        const result = invoke("reply-and-resolve.mjs", ["thread-one"]);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("not-a-real-token");
        expect(result.stderr).not.toContain("posted");
        expect(calls()).toHaveLength(1);
        expect(calls()[0]?.args).toEqual(["api", "graphql", "--input", "-"]);
        expect(calls()[0]?.payload.variables).toEqual({ thread: "thread-one" });
        if (failure === "resolve-transport") {
          expect(result.stderr).toContain("resolve transport refused");
          expect(result.stderr).toContain("[redacted]");
        }
      },
      { failure },
    );
  },
  30_000,
);

test.each([
  "transport",
  "reply-invalid",
  "invalid-json",
  "resolve-transport",
  "resolve-graphql",
  "unresolved",
])(
  "reply helper never reports success on %s",
  (failure) => {
    fixture(
      (root, invoke, calls) => {
        const path = join(root, "reply.txt");
        writeFileSync(path, "review reply");
        const result = invoke("reply-and-resolve.mjs", [
          "owner",
          "repo",
          "123",
          "42",
          "thread-one",
          path,
        ]);
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("true");
        expect(calls()).toHaveLength(
          ["transport", "reply-invalid", "invalid-json"].includes(failure)
            ? 1
            : 2,
        );
      },
      { failure },
    );
  },
  30_000,
);
