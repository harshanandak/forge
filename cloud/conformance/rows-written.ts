import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tinySource, pagesOf, type Tables } from "./max-source.ts";

const base = process.env.CLOUD_BASE!;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const state = join(process.env.RUNNER_TEMP!, "rows-written.json");
const project = `rows-${Date.now()}`;
const failures: string[] = [];
type Doc = { format: string; tables: Tables };
async function call(
  target: string,
  route: string,
  body?: unknown,
  fault?: string,
) {
  const response = await fetch(`${base}/p/${target}/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${process.env.CLOUD_ADMIN_TOKEN!}`,
      "x-cloud-cold": "1",
      ...(fault ? { "x-cloud-fault": fault } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const writes = ["sql", "kv"].map((kind) => {
    const value = response.headers.get(`x-cloud-${kind}-writes`);
    assert.match(value ?? "", /^\d+$/);
    return Number(value);
  });
  return {
    response,
    text,
    writes,
    body: JSON.parse(text) as {
      value: Doc & { initialized: boolean; next: string | null };
    },
  };
}
async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    console.log(`PASS rows written: ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL rows written: ${name}: ${String(error)}`);
  }
}
async function reads(target: string, expected?: Doc) {
  const status = await call(target, "status");
  assert.equal(status.response.status, 200);
  assert.equal(status.body.value.initialized, true);
  assert.deepEqual(status.writes, [0, 0], "status must write zero SQL/KV rows");
  const whole = await call(target, "dump");
  assert.equal(whole.response.status, 200);
  assert.deepEqual(
    whole.writes,
    [0, 0],
    "whole dump must write zero SQL/KV rows",
  );
  if (expected) assert.deepEqual(whole.body.value, expected);
  const tables: Tables = Object.fromEntries(
    Object.keys(whole.body.value.tables).map((key) => [key, []]),
  );
  let cursor: string | null = "start",
    count = 0;
  while (cursor !== null) {
    assert.ok(++count < 100, "export must terminate");
    const page = await call(
      target,
      `dump?cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(page.response.status, 200);
    assert.deepEqual(
      page.writes,
      [0, 0],
      "every dump page must write zero rows",
    );
    for (const [table, rows] of Object.entries(page.body.value.tables))
      tables[table]!.push(...rows);
    cursor = page.body.value.next;
  }
  assert.deepEqual(tables, whole.body.value.tables, "all exported rows agree");
  console.log(
    `INFO rows written ${target}: status=0 whole=0 paged=0 pages=${count}`,
  );
  return whole.body.value;
}

if (process.argv[2] === "restart") {
  const saved = JSON.parse(readFileSync(state, "utf8")) as {
    target: string;
    doc: Doc;
  };
  await check("cold status and complete export", () =>
    reads(saved.target, saved.doc).then(() => {}),
  );
} else {
  const fixture = await tinySource("quota read synthetic " + "x".repeat(700));
  for (const paged of [false, true]) {
    const target = `${project}-${paged ? "paged" : "whole"}`;
    await check(
      `${paged ? "paged" : "whole"} restore and read accounting`,
      async () => {
        let written = 0,
          sql = 0,
          kv = 0;
        for (const page of paged ? pagesOf(fixture.tables, 2) : [fixture.doc]) {
          const restored = await call(target, "restore", page);
          assert.equal(restored.response.status, 200, restored.text);
          sql += restored.writes[0]!;
          kv += restored.writes[1]!;
          written += restored.writes.reduce((sum, n) => sum + n, 0);
        }
        const records = Object.values(fixture.tables).reduce(
          (sum, rows) => sum + rows.length,
          0,
        );
        assert.ok(written > records);
        console.log(
          `INFO rows written restore ${paged ? "paged" : "whole"}: sql=${sql} kv=${kv} inputRows=${records} total=${written} perInputRow=${written / records} records=${fixture.tables.state_records!.length} perStateRecord=${written / fixture.tables.state_records!.length}`,
        );
        const doc = await reads(target);
        if (!paged) writeFileSync(state, JSON.stringify({ target, doc }));
      },
    );
  }
  for (const fault of ["quota", "quota-kv", "read-quota", "storage-full"]) {
    for (const route of [
      "status",
      "dump",
      "dump?cursor=start",
      "devices",
      "restore",
    ]) {
      await check(`${fault} on ${route} is named and sanitized`, async () => {
        const target =
          route === "restore"
            ? `${project}-fault-${fault}`
            : `${project}-whole`;
        const payload =
          route === "devices"
            ? { device: "synthetic-sensitive-device" }
            : route === "restore"
              ? fixture.doc
              : undefined;
        const result = await call(target, route, payload, fault);
        const storage = fault === "storage-full";
        assert.equal(result.response.status, 503);
        assert.deepEqual(result.body, {
          ok: false,
          error: {
            code: storage ? "STORAGE_LIMIT_EXCEEDED" : "QUOTA_EXHAUSTED",
            message: storage
              ? "Project storage limit exceeded"
              : "Durable Object daily quota exhausted; retry after 00:00 UTC",
            retry: storage ? "never" : "safe",
          },
        });
        assert.equal(result.response.headers.get("authorization"), null);
        assert.equal(result.response.headers.get("x-cloud-fault"), null);
      });
    }
  }
}
assert.deepEqual(failures, []);
