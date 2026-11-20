// [integration] The installed package: a cloud-bound project's issue show is answered by the cloud
// through the npm-installed forge.js on Node, with no Bun on the child's PATH and no local store.
import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { packedConsumer } from "../../integration/packed-consumer.ts";
import {
  cloudRig,
  proveRead,
  SHOW,
  ISSUE,
  LANE,
  GRANT,
  refuse,
} from "./fixture.ts";

setDefaultTimeout(60_000);

const install = () =>
  join(packedConsumer(), "node_modules/forge-workflow/dist/bin/forge.js");
const closed = () => ({
  status: 503,
  body: {
    ok: false,
    status: "FAIL",
    warnings: [],
    error: {
      code: "UNAVAILABLE",
      message: "Cloud projects arrive with v3.",
      retry: "never",
    },
  },
});

test("the installed CLI and MCP preserve a copied binding and credential after the server refuses writes", async () => {
  const f = await cloudRig(install(), closed);
  try {
    const before = f.profile();
    expect(before.filter(Boolean)).toHaveLength(2);
    const cli = await f.run([
      "issue",
      "create",
      "--title",
      "Refused CLI issue",
    ]);
    expect(cli.status).toBe(1);
    const mcp = await f.mcp("issue_create", { title: "Refused MCP issue" });
    for (const reply of [cli, mcp]) {
      expect(reply.envelope).toMatchObject({
        ok: false,
        status: "FAIL",
        error: { code: "UNAVAILABLE", retry: "never" },
      });
      f.expectUntouched(reply);
    }
    expect(
      f.requests.map(({ method, url, body }) => {
        const command = body as
          { op?: unknown; input?: { title?: unknown } } | undefined;
        return [method, url, command?.op, command?.input?.title];
      }),
    ).toEqual([
      ["POST", "/p/proj/command", "issue.create", "Refused CLI issue"],
      ["POST", "/p/proj/command", "issue.create", "Refused MCP issue"],
    ]);
    expect(f.profile()).toEqual(before);
  } finally {
    await f.close();
  }
});

test("the installed CLI receives a login refusal before a challenge or profile write", async () => {
  const f = await cloudRig(install(), closed, "unbound", {
    device: "dev-1",
    session: "cloud-dist-test",
  });
  try {
    const result = await f.run([
      "auth",
      "login",
      "--origin",
      f.origin,
      "--project",
      "p",
    ]);
    expect(result.status).toBe(1);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: { code: "LOGIN_REFUSED" },
    });
    expect(f.requests.map(({ url }) => url)).toEqual(["/p/p/loginstart"]);
    expect(f.profile()).toEqual([null, null]);
  } finally {
    await f.close();
  }
});

test("the unbound installed CLI and MCP still create and read local issues", async () => {
  const f = await cloudRig(install(), closed, "unbound");
  try {
    const cli = await f.run(["issue", "create", "--title", "Local CLI issue"]);
    expect(cli.status).toBe(0);
    expect(cli.envelope).toMatchObject({
      ok: true,
      result: { id: "forge-1", title: "Local CLI issue" },
    });
    const mcp = await f.mcp("issue_create", { title: "Local MCP issue" });
    expect(mcp.envelope).toMatchObject({
      ok: true,
      result: { id: "forge-2", title: "Local MCP issue" },
    });
    expect((await f.run(["issue", "show", "forge-2"])).envelope).toMatchObject({
      ok: true,
      result: { title: "Local MCP issue" },
    });
    expect(f.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

test("the installed package answers issue show for a bound project from the cloud, on Node with no Bun", async () => {
  const bin = join(
    packedConsumer(),
    "node_modules/forge-workflow/dist/bin/forge.js",
  );
  const f = await cloudRig(bin);
  try {
    const path = Object.entries(f.env).find(
      ([name]) => name.toLowerCase() === "path",
    )?.[1];
    expect(Bun.which("bun", { PATH: path ?? "" })).toBeNull();
    await proveRead(f, SHOW);
  } finally {
    await f.close();
  }
}, 60_000);

test("installed CLI and MCP read device attachments without acquiring a local project owner", async () => {
  const bin = join(
    packedConsumer(),
    "node_modules/forge-workflow/dist/bin/forge.js",
  );
  const f = await cloudRig(
    bin,
    ({ body }) =>
      (body as { op: string }).op === "issue.show"
        ? {
            status: 200,
            body: {
              ok: true,
              op: "issue.show",
              status: "OK",
              result: { ...ISSUE, lease: GRANT },
              warnings: [],
            },
          }
        : refuse("UNAVAILABLE", 503),
    "attached",
  );
  try {
    for (const surface of ["CLI", "MCP"] as const)
      for (const [verb, input, expected] of [
        ["show", { id: ISSUE.id }, { ...LANE, issue: ISSUE.id, lease: GRANT }],
        [
          "status",
          {},
          { enabled: false, lanes: [{ id: ISSUE.id, step: "attached" }] },
        ],
      ] as const) {
        const before = f.requests.length;
        const out =
          surface === "CLI"
            ? await f.run([
                "lane",
                verb,
                ...(verb === "show" ? [ISSUE.id] : []),
              ])
            : await f.mcp(`lane_${verb}`, input);
        expect(out.envelope).toMatchObject({
          ok: true,
          op: `lane.${verb}`,
          result: expected,
        });
        expect(f.requests).toHaveLength(before + 1);
        expect(f.requests[before]).toMatchObject({
          body: { op: "issue.show", input: { id: ISSUE.id } },
        });
        f.expectUntouched(out);
      }
  } finally {
    await f.close();
  }
}, 60_000);
