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
    true,
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
