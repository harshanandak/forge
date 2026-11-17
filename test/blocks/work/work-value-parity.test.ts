import { test, setDefaultTimeout, afterAll, spyOn } from "bun:test";
import { deepStrictEqual as eq, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inlineWorkPrimitives } from "../../../tools/bundle-work-primitives.ts";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { BoundContext } from "../../../src/generated/types.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import {
  validateWorkRecord,
  assertWorkRecord,
} from "../../../src/blocks/work/validation.ts";
import { domain } from "../../../cloud/src/project.ts";
import { durableStore } from "../../../cloud/src/store.ts";
import { createIssue } from "../../../cloud/src/issue-create.ts";
import { updateIssue } from "../../../cloud/src/issue-update.ts";
import { closeIssue } from "../../../cloud/src/issue-close.ts";
import { commentIssue } from "../../../cloud/src/issue-comment.ts";
import { linkIssue } from "../../../cloud/src/issue-link.ts";
import type { WriteCall } from "../../../cloud/src/issue-write.ts";

import { Catalog, captureBlock } from "../../../src/core/catalog/index.ts";
import { Runtime } from "../../../src/core/runtime/index.ts";
import { nodeRunIsolation } from "../../../src/adapters/node-runtime/isolation.ts";
import { TrustStore, admit, grant } from "../../fixtures/owner-approval.ts";

setDefaultTimeout(30_000);
const at = "2026-11-16T00:00:00.000Z",
  stamp = Date.parse(at);
const actor = { kind: "agent", id: "value-parity" } as const;
const holder = { actor, session: { id: "parity", device: "fixture" } };
const issue = {
  id: "work-1",
  title: "one",
  status: "open",
  labels: [],
  dependsOn: [],
  createdAt: at,
};
const checkpoint = {
  step: "green",
  branch: "fix/one",
  worktree: "/fixture",
  next: "review",
};
const comment = { id: "work-1", body: "one" };
const link = {
  id: "work-1",
  relation: "docs",
  url: "https://example.test/one",
};
type Row = readonly [
  key: string,
  value: unknown,
  reason?: string | undefined,
  op?: string | undefined,
  input?: unknown,
  localOnly?: boolean,
];
const table: readonly Row[] = [
  ["issue:work-1", issue, undefined, "issue.create", { title: "one" }],
  ...["id", "parent", "dependsOn"].map<Row>((field) => [
    "issue:work-1",
    { ...issue, [field]: field === "dependsOn" ? ["bogus"] : "bogus" },
    "WORK_VALUE_ID",
    field === "id" ? "issue.update" : "issue.create",
    field === "id"
      ? { id: "bogus", expectRevision: 1 }
      : { title: "one", [field]: field === "dependsOn" ? ["bogus"] : "bogus" },
  ]),
  [
    "issue:work-1",
    { ...issue, title: "" },
    "WORK_VALUE_SHAPE",
    "issue.create",
    { title: "" },
  ],
  [
    "issue:work-1",
    { ...issue, revision: 1 },
    "WORK_VALUE_SHAPE",
    "issue.create",
    { title: "one", revision: 1 },
  ],
  ["issue:work-1", null, "WORK_VALUE_SHAPE", "issue.create", null],
  ["comment:work-1:1", comment, undefined, "issue.comment", comment],
  [
    "comment:work-1:1",
    { ...comment, call: 1 },
    undefined,
    "issue.call",
    { id: "work-1", role: "build" },
    true,
  ],
  [
    "comment:work-1:1",
    { ...comment, checkpoint },
    undefined,
    "issue.checkpoint",
    { id: "work-1", ...checkpoint },
    true,
  ],
  [
    "comment:work-1:1",
    { ...comment, call: 1, checkpoint },
    "WORK_VALUE_COMMENT_KIND",
    "issue.comment",
    { ...comment, call: 1, checkpoint },
  ],
  ["comment:work-1:1", null, "WORK_VALUE_SHAPE", "issue.comment", null],
  ["link:work-1:1", link, undefined, "issue.link", link],
  [
    "link:work-1:1",
    { ...link, url: "http://example.test/one" },
    undefined,
    "issue.link",
    { ...link, url: "http://example.test/one" },
  ],
  [
    "link:work-1:1",
    { ...link, url: "javascript:alert(1)" },
    "WORK_VALUE_URL",
    "issue.link",
    { ...link, url: "javascript:alert(1)" },
  ],
  ["link:work-1:1", null, "WORK_VALUE_SHAPE", "issue.link", null],
  [
    "issue:bogus",
    { ...issue, id: "bogus" },
    "WORK_VALUE_KEY",
    "issue.update",
    { id: "bogus", expectRevision: 1 },
  ],
  ...["\n", "\r", "\u2028", "\u2029"].map<Row>((end) => [
    "comment:work-1:1" + end,
    comment,
    "WORK_VALUE_KEY",
  ]),
  ...["parent", "dependsOn"].map<Row>((field) => [
    "issue:work-1",
    { ...issue, [field]: field === "dependsOn" ? ["work-1\n"] : "work-1\n" },
    "WORK_VALUE_ID",
  ]),
  ...["future-family", "__proto__", "constructor", "attempt"].map<Row>(
    (family) => [family + ":work-1", {}, "WORK_VALUE_FAMILY"],
  ),
  ...[0, 61, 1.5, "1"].map<Row>((call) => [
    "comment:work-1:1",
    { ...comment, call },
    "WORK_VALUE_SHAPE",
  ]),
  ["comment:work-1:1", { ...comment, call: 60 }],
  [
    "comment:work-1:1",
    { ...comment, checkpoint: { ...checkpoint, next: "" } },
    "WORK_VALUE_SHAPE",
  ],
  ["issue:work-1", { ...issue, labels: ["one", "one"] }, "WORK_VALUE_SHAPE"],
  ...["task", "bug", "feature", "epic"].map<Row>((kind) => [
    "issue:work-1",
    { ...issue, kind },
    undefined,
    "issue.create",
    { title: "one", kind },
  ]),
  [
    "issue:work-1",
    { ...issue, kind: "unknown" },
    "WORK_VALUE_SHAPE",
    "issue.create",
    { title: "one", kind: "unknown" },
  ],
  ["issue:work-0", { ...issue, id: "work-0" }],
  ["issue:work-01", { ...issue, id: "work-01" }],
  [
    "issue:work-1",
    { ...issue, status: "closed" },
    "WORK_VALUE_CLOSE_EVIDENCE",
    "issue.close",
    { id: "work-1" },
  ],
  ["issue:work-1", { ...issue, status: "closed", receipt: "check-1" }],
  ["issue:work-1", { ...issue, status: "closed", withoutReceipt: "fixture" }],
  ...Object.entries({ comment, link }).flatMap(([family, value]) =>
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1].map<Row>(
      (suffix) => [
        family + ":work-1:" + suffix,
        value,
        suffix === Number.MAX_SAFE_INTEGER ? undefined : "WORK_VALUE_KEY",
      ],
    ),
  ),
  [
    "issue:work-2",
    { ...issue, id: "work-2", dependsOn: ["work-1"] },
    undefined,
    "issue.create",
    { title: "aliases", dependsOn: ["work-1", "forge-1"] },
    true,
  ],
];
const cases = table.map(([key, value, reason, op, input, localOnly]) => ({
  key,
  value,
  reason,
  op,
  input,
  localOnly,
}));
const clock = spyOn(Date, "now").mockReturnValue(stamp);
afterAll(() => clock.mockRestore());
const workEntry = await inlineWorkPrimitives(
  new Bun.Transpiler({ loader: "ts" }).transformSync(
    readFileSync(
      new URL("../../../src/blocks/work/entry.cts", import.meta.url),
      "utf8",
    ),
  ),
  resolve(import.meta.dirname, "../../../src/blocks/work/record-primitives.ts"),
);
const block = captureBlock("work", {
  open: () => ({
    ownership: "borrowed",
    value: {
      read(name) {
        const file =
          name === "block.json"
            ? "forge.block.json"
            : name === "entry.cjs"
              ? "entry.cts"
              : name;
        const bytes = readFileSync(
          new URL("../../../src/blocks/work/" + file, import.meta.url),
        );
        return name === "entry.cjs"
          ? new TextEncoder().encode(workEntry)
          : bytes;
      },
    },
  }),
});
const catalog = new Catalog(
  {
    schemaVersion: "forge.config/1",
    blocks: {
      work: {
        source: { path: "./work" },
        bind: { state: "core" },
        config: { idPrefix: "forge" },
      },
    },
  },
  new Map([["work", block]]),
  undefined,
  ["forge.state@1.0.0"],
);
const trust = new TrustStore();
admit(trust, block.digest);
grant(trust, block.digest, [
  "issue:write",
  "external:process",
  "external:network",
  "environment:read",
]);
const cloud = {
  "issue.create": createIssue,
  "issue.update": updateIssue,
  "issue.close": closeIssue,
  "issue.comment": commentIssue,
  "issue.link": linkIssue,
};
for (const [index, row] of cases.entries()) {
  test(`primary work engine ${index}: ${row.reason ?? "valid"}`, () => {
    eq(validateWorkRecord(row.key, row.value), row.reason);
    if (row.reason)
      throws(
        () => assertWorkRecord(row.key, row.value),
        (error: unknown) =>
          error instanceof ForgeFailure &&
          error.error.code === "INPUT_INVALID" &&
          error.error.message === row.reason,
      );
    else assertWorkRecord(row.key, row.value);
  });
  if (!row.op) continue;
  for (const backend of row.localOnly ? ["local"] : ["local", "cloud"])
    test(`primary writer parity ${index} ${backend}`, async () => {
      const opened = await createSqliteStore(process.cwd()).open({
        path: ":memory:",
        readOnly: false,
      });
      if (!opened.ok) throw new Error("Fixture store refused");
      const local = opened.handle.value;
      const db =
          backend === "cloud"
            ? durableStore({
                sql: {
                  exec: (sql, ...bindings) => {
                    const rows = local.all(
                      sql,
                      bindings.map((value) =>
                        value instanceof ArrayBuffer
                          ? new Uint8Array(value)
                          : value,
                      ),
                    );
                    return { toArray: () => rows.map((row) => ({ ...row })) };
                  },
                },
                transactionSync: (body) => local.transaction(body),
                get: () => Promise.resolve(undefined),
                put: () => Promise.resolve(),
                delete: () => Promise.resolve(undefined),
              })
            : local,
        owner = new StateOwner(db, { now: () => stamp });
      try {
        owner.initialize(backend === "cloud" ? [domain] : []);
        owner.put("forge/work", "issue:work-1", issue, actor, {
          expectRevision: 0,
        });
        owner.put(
          "forge/work",
          "allocation:issue:work-",
          { prefix: "issue:work-", number: 1 },
          actor,
          { expectRevision: 0 },
        );
        const lease = owner.acquire(
          "forge/work",
          "issue:work-1",
          holder,
          60000,
          `lease-${index}`,
        );
        let request = 0;
        const runtime = new Runtime(catalog, trust, {
          clock: { now: () => stamp },
          isolation: nodeRunIsolation,
          services: (_instance, context) =>
            Promise.resolve({
              ownership: "borrowed",
              value: {
                state: createStateClient({
                  owner,
                  namespace: "forge/work",
                  context,
                  write: true,
                  requestId: `service-${request}`,
                }),
              },
            }),
        });
        const invoke = (op: string, input: unknown) => {
          const context: BoundContext = [
            "issue.update",
            "issue.close",
            "issue.link",
          ].includes(op)
            ? {
                variant: "leased",
                leaseMode: "held",
                actor,
                session: holder.session,
                project: { id: "fixture" },
                leaseGeneration: lease.generation,
              }
            : { variant: "project", actor, project: { id: "fixture" } };
          if (backend === "local")
            return runtime
              .invoke({
                schemaVersion: "forge.invocation/1",
                requestId: `local-${request++}`,
                op,
                input,
                caller: "agent",
                context: {
                  ...holder,
                  project: { id: "fixture" },
                  leaseGeneration: lease.generation,
                },
              })
              .then((result) => {
                if (!result.ok) throw new ForgeFailure(result.error);
                return result.result;
              });
          const write = cloud[op as keyof typeof cloud];
          const call: WriteCall = {
            input,
            context,
            principal: ["owner", "fixture", "parity"],
            requestId: `cloud-${request++}`,
            device: "fixture",
            prefix: "work",
            recheck: () => {},
            expiresAt: stamp + 3_600_000,
          };
          return write(db, owner, call);
        };
        let refusal: unknown;
        try {
          await invoke(row.op!, row.input);
        } catch (error) {
          refusal = error;
        }
        if (row.reason) {
          eq(
            refusal instanceof ForgeFailure && refusal.error.code,
            row.reason === "WORK_VALUE_CLOSE_EVIDENCE"
              ? "RECEIPT_REQUIRED"
              : "INPUT_INVALID",
          );
        } else {
          if (refusal)
            throw new Error("Writer refused valid fixture", { cause: refusal });
          if (index === 0) {
            await invoke("issue.update", {
              id: "work-1",
              expectRevision: owner.get("forge/work", "issue:work-1")!.revision,
              title: "updated",
            });
            await invoke("issue.close", {
              id: "work-1",
              withoutReceipt: "fixture",
            });
          }
          if (row.localOnly && row.op === "issue.create") {
            eq(
              (
                owner.get("forge/work", "issue:work-2")!.value as {
                  dependsOn: string[];
                }
              ).dependsOn,
              ["work-1"],
            );
            owner.acquire(
              "forge/work",
              "issue:work-2",
              holder,
              60000,
              `alias-${index}`,
            );
            await invoke("issue.update", {
              id: "work-2",
              expectRevision: owner.get("forge/work", "issue:work-2")!.revision,
              dependsOn: ["work-1", "forge-1"],
            });
            eq(
              (
                owner.get("forge/work", "issue:work-2")!.value as {
                  dependsOn: string[];
                }
              ).dependsOn,
              ["work-1"],
            );
          }
        }
        for (const record of owner.list("forge/work"))
          if (["issue", "comment", "link"].includes(record.key.split(":")[0]!))
            eq(validateWorkRecord(record.key, record.value), undefined);
      } finally {
        await opened.handle.close();
      }
    });
}
