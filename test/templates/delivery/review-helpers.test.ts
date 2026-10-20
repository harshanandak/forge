import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Gh = (args: string[]) => string;
interface ListModule {
  readonly listThreads: (args: string[], gh: Gh) => Record<string, unknown>[];
}
interface ResolveModule {
  readonly replyAndResolve: (
    args: string[],
    gh: Gh,
    read: (path: string) => string,
  ) => unknown;
}

const scripts = resolve(
  import.meta.dirname,
  "../../../templates/delivery/scripts",
);
/** The helpers are plain JavaScript for users' Node, so the test states the shape it relies on. */
const load = async <T>(name: string): Promise<T> => {
  const module: unknown = await import(
    pathToFileURL(resolve(scripts, name)).href
  );
  return module as T;
};

/** A fake `gh`: records each call's arguments and answers from a queue. */
function fakeGh(...answers: unknown[]): { gh: Gh; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args) => {
      calls.push(args);
      return JSON.stringify(answers.shift());
    },
  };
}

const thread = (id: string, isResolved: boolean, body: string) => ({
  id,
  isResolved,
  path: "src/a.ts",
  line: 12,
  comments: {
    nodes: [{ databaseId: 501, author: { login: "codex-bot" }, body }],
  },
});

test("review-threads lists only unresolved threads with ids, place, author and a short body", async () => {
  const { listThreads } = await load<ListModule>("review-threads.mjs");
  const { gh, calls } = fakeGh({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [
              thread(
                "PRRT_open",
                false,
                `**P1** the\nlease ${"x".repeat(200)}`,
              ),
              thread("PRRT_done", true, "fixed"),
            ],
          },
        },
      },
    },
  });
  const listed = listThreads(["61"], gh);
  const body = `**P1** the lease ${"x".repeat(100)}...`;
  expect(body).toHaveLength(120);
  expect(listed).toEqual([
    {
      thread: "PRRT_open",
      comment: 501,
      path: "src/a.ts",
      line: 12,
      author: "codex-bot",
      body,
    },
  ]);
  // the repo comes from gh's own placeholders, never a hard-coded owner
  for (const arg of ["graphql", "owner={owner}", "name={repo}", "pr=61"])
    expect(calls[0]).toContain(arg);
  expect(() => listThreads(["sixty"], gh)).toThrow("usage");
}, 30_000);

test("resolve-thread posts the reply to the thread, then resolves it, and refuses an unresolved read-back", async () => {
  const { replyAndResolve } = await load<ResolveModule>("resolve-thread.mjs");
  const resolved = {
    data: {
      resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
    },
  };
  const reply = { id: 9, html_url: "https://github.test/r/9" };
  const { gh, calls } = fakeGh(reply, resolved);
  const read = () => 'Fixed in abc123: it\'s "quoted" & safe\n';
  expect(
    replyAndResolve(["61", "501", "PRRT_1", "reply.md"], gh, read),
  ).toEqual({
    replied: 9,
    url: "https://github.test/r/9",
    thread: "PRRT_1",
    resolved: true,
  });
  expect(calls[0]).toEqual([
    "api",
    "--method",
    "POST",
    "repos/{owner}/{repo}/pulls/61/comments/501/replies",
    "-f",
    'body=Fixed in abc123: it\'s "quoted" & safe',
  ]);
  expect(calls[1]?.slice(0, 4)).toEqual([
    "api",
    "graphql",
    "-f",
    "thread=PRRT_1",
  ]);
  expect(calls[1]?.[5]).toContain("resolveReviewThread");

  const stuck = fakeGh(reply, { errors: [{ message: "forbidden" }] });
  expect(() =>
    replyAndResolve(["61", "501", "PRRT_1", "reply.md"], stuck.gh, read),
  ).toThrow("is not resolved");
  const empty = fakeGh();
  expect(() =>
    replyAndResolve(["61", "501", "PRRT_1", "reply.md"], empty.gh, () => " \n"),
  ).toThrow("is empty");
  expect(empty.calls).toEqual([]);
}, 30_000);
