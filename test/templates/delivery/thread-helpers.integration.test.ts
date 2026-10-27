import { expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const helpers = resolve(
  import.meta.dirname,
  "../../../templates/delivery/skills/forge-review",
);
const thread = (id: string, isResolved = false) => ({
  id,
  isResolved,
  comments: {
    nodes: [
      {
        databaseId: 42,
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
  ) => void,
  options: { pages?: Page[]; failure?: string } = {},
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
      `import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.GH_TEST_ROOT;
const scenario = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8'));
const args = process.argv.slice(2);
const payload = JSON.parse(readFileSync(args[args.indexOf('--input') + 1] === '-' ? 0 : args[args.indexOf('--input') + 1], 'utf8'));
const previous = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\\n').filter(Boolean);
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ args, payload }) + '\\n');
const resolving = payload.query?.includes('resolveReviewThread');
const listing = payload.query?.includes('reviewThreads');
if (scenario.failure === 'transport' || (resolving && scenario.failure === 'resolve-transport')) process.exit(1);
let response;
if (listing) {
  const page = scenario.pages?.[previous.length];
  response = { data: { repository: { pullRequest: { reviewThreads: page } } } };
  if (scenario.failure === 'graphql' || (scenario.failure === 'last-page-errors' && previous.length)) response.errors = [{ message: 'refused' }];
} else if (resolving) {
  response = { data: { resolveReviewThread: { thread: { isResolved: scenario.failure !== 'unresolved' } } } };
  if (scenario.failure === 'resolve-graphql') response.errors = [{ message: 'refused' }];
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
    run(root, invoke, calls);
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
          commentId: 42,
          path: "src/example.ts",
          line: 7,
          author: "reviewer",
          body: "x".repeat(200),
        },
        {
          id: "open-two",
          commentId: 42,
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
      expect(requests[0]?.payload.query).toMatch(/reviewThreads\(first:\s*100/);
      expect(requests[0]?.payload.query).toMatch(/comments\(first:\s*1/);
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

test.each([
  "transport",
  "graphql",
  "invalid-json",
  "missing-page",
  "missing-cursor",
  "repeated-cursor",
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
    expect(invoke("reply-and-resolve.mjs", []).status).not.toBe(0);
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
