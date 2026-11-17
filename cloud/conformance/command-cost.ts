import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StatementProfile } from "./write-profile.ts";

interface Measurement {
  command: string;
  size: number;
  recordsBefore: number;
  eventsBefore: number;
  receiptsBefore: number;
  writes: number;
  sqlWrites: number;
  kvWrites: number;
  reads: number;
  kvGets: number;
  returned: number | null;
  statements: StatementProfile[];
}
interface Reply {
  ok: boolean;
  status?: string;
  result?: unknown;
  value?: unknown;
  error?: { code?: string };
}
const directory = process.env.RUNNER_TEMP!;
const output = (size: number) => join(directory, `command-cost-${size}.json`);

if (process.argv[2] === "report") {
  const results = [1_000, 8_000].flatMap(
    (size) => JSON.parse(readFileSync(output(size), "utf8")) as Measurement[],
  );
  const names = [...new Set(results.map((r) => r.command))];
  assert.equal(names.length, 12);
  const fits = names.map((command) => {
    const points = results
      .filter((r) => r.command === command)
      .sort((a, b) => a.size - b.size);
    assert.equal(points.length, 2);
    const [a, b] = points as [Measurement, Measurement];
    const fit = (column: "writes" | "reads" | "kvGets") => {
      const perRecord = (b[column] - a[column]) / (b.size - a.size);
      return { fixed: a[column] - perRecord * a.size, perRecord, points: 2 };
    };
    return {
      command,
      writes: fit("writes"),
      reads: fit("reads"),
      kvGets: fit("kvGets"),
    };
  });
  const writes: Record<string, number> = {
    "issue.create": 29,
    "issue.claim": 21,
    "issue.update": 16,
    "issue.comment": 32,
    "issue.release": 16,
    "issue.close": 16,
    "lease.acquire": 19,
    "lease.renew": 14,
  };
  for (const fit of fits) {
    if (
      ["status", "issue.list", "issue.ready", "issue.show"].includes(
        fit.command,
      )
    )
      assert.ok(
        Math.abs(fit.reads.perRecord) < 0.05,
        `${fit.command} reads grow by ${fit.reads.perRecord} per record`,
      );
    if (fit.command in writes)
      assert.ok(
        fit.writes.fixed <= writes[fit.command]! + 2,
        `${fit.command} writes ${fit.writes.fixed}, more than 2 over ${writes[fit.command]}`,
      );
  }
  console.log(`COMMAND_COST_FIT ${JSON.stringify(fits)}`);
  writeFileSync(
    join(directory, "command-cost.json"),
    JSON.stringify({ results, fits }, null, 2),
  );
} else {
  const size = Number(process.argv[2]);
  assert.ok(size === 1_000 || size === 8_000);
  const base = process.env.CLOUD_BASE!;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const project = process.env.FORGE_CLOUD_PROJECT!;
  const admin = process.env.CLOUD_ADMIN_TOKEN!;
  let token = admin,
    sequence = 0;
  const actor = { kind: "agent", id: "command-cost" };
  const session = "command-cost-session";
  const context = { actor, session: { id: session } };
  const held = (generation: number) => ({
    ...context,
    leaseGeneration: generation,
  });
  const results: Measurement[] = [];

  async function call(
    route: string,
    body?: unknown,
    profile = false,
    authorization = token,
    seed = false,
  ) {
    const response = await fetch(`${base}/p/${project}/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${authorization}`,
        ...(profile ? { "x-cloud-write-profile": "1" } : {}),
        ...(seed ? { "x-cloud-command-seed": String(size) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const parsed = (await response.json()) as
      Reply | { response: Reply; profile: StatementProfile[] };
    const reply = profile
      ? (parsed as { response: Reply }).response
      : (parsed as Reply);
    assert.equal(
      response.status,
      200,
      `${route} HTTP ${response.status}, ${reply.error?.code ?? "unknown"}`,
    );
    assert.equal(reply.ok, true, `${route} ${reply.error?.code ?? "not ok"}`);
    const metric = (name: string) => {
      const raw = response.headers.get(`x-cloud-${name}`);
      assert.match(raw ?? "", /^\d+$/);
      return Number(raw);
    };
    const statements = profile
      ? (parsed as { profile: StatementProfile[] }).profile
      : [];
    const sqlWrites = metric("sql-writes"),
      kvWrites = metric("kv-writes"),
      reads = metric("sql-reads"),
      kvGets = metric("kv-gets");
    if (profile) {
      assert.equal(
        statements.reduce((n, p) => n + p.rows, 0),
        sqlWrites,
      );
      assert.equal(
        statements.reduce((n, p) => n + p.reads, 0),
        reads,
      );
    }
    return { reply, statements, sqlWrites, kvWrites, reads, kvGets };
  }
  function command(
    op: string,
    input: object,
    commandContext: object = { actor },
  ) {
    return {
      requestId: `cost-${++sequence}`,
      op,
      input,
      context: commandContext,
    };
  }
  async function counts() {
    const r = await call("status", undefined, false, admin);
    const rows = (r.reply.value as { dump: { rows: Record<string, number> } })
      .dump.rows;
    return {
      recordsBefore: rows.state_records!,
      eventsBefore: rows.state_events!,
      receiptsBefore: rows.domain_cloud_command_receipts!,
    };
  }
  async function measure(
    name: string,
    route: string,
    body?: unknown,
    readonly = false,
  ) {
    const before = await counts();
    const r = await call(route, body, true, name === "status" ? admin : token);
    const result = (r.reply.result ?? r.reply.value) as { items?: unknown[] };
    const row: Measurement = {
      command: name,
      size,
      ...before,
      writes: r.sqlWrites + r.kvWrites,
      sqlWrites: r.sqlWrites,
      kvWrites: r.kvWrites,
      reads: r.reads,
      kvGets: r.kvGets,
      returned: result.items?.length ?? null,
      statements: r.statements,
    };
    if (readonly) {
      assert.equal(row.writes, 0);
      assert.deepEqual(await counts(), before);
    }
    results.push(row);
    console.log(
      `COMMAND_COST ${JSON.stringify({ ...row, statements: undefined })}`,
    );
    writeFileSync(output(size), JSON.stringify(results, null, 2));
    return r.reply.result ?? r.reply.value;
  }

  const device = await call(
    "devices",
    { device: "command-cost-device", session, ttlMs: 3_600_000 },
    false,
    admin,
    true,
  );
  token = (device.reply.value as { token: string }).token;
  assert.equal(typeof token, "string");
  const initial = await counts();
  assert.equal(initial.recordsBefore, size + 1);
  assert.equal(initial.eventsBefore, size + 1);
  assert.equal(initial.receiptsBefore, 0);

  const created = (await measure(
    "issue.create",
    "command",
    command("issue.create", { title: "Measured create" }),
  )) as { id: string };
  assert.equal(created.id, `work-${size + 1}`);
  const claimed = (await measure(
    "issue.claim",
    "command",
    command("issue.claim", { id: "work-1", ttlSeconds: 600 }, context),
  )) as { generation: number };
  assert.equal(claimed.generation, 1);
  const updated = (await measure(
    "issue.update",
    "command",
    command(
      "issue.update",
      { id: "work-1", title: "Measured update", expectRevision: 1 },
      held(claimed.generation),
    ),
  )) as { revision: number };
  assert.equal(updated.revision, 2);
  await measure(
    "issue.comment",
    "command",
    command("issue.comment", { id: "work-1", body: "Measured comment" }),
  );
  await measure(
    "issue.release",
    "command",
    command("issue.release", { id: "work-1" }, held(claimed.generation)),
  );
  const closeLease = (
    await call(
      "command",
      command("issue.claim", { id: "work-2", ttlSeconds: 600 }, context),
    )
  ).reply.result as { generation: number };
  const closed = (await measure(
    "issue.close",
    "command",
    command(
      "issue.close",
      { id: "work-2", withoutReceipt: "Synthetic measurement" },
      held(closeLease.generation),
    ),
  )) as { status: string };
  assert.equal(closed.status, "closed");
  await measure("status", "status", undefined, true);
  await measure("issue.list", "command", command("issue.list", {}), true);
  await measure(
    "issue.show",
    "command",
    command("issue.show", { id: "work-1" }),
    true,
  );
  await measure("issue.ready", "command", command("issue.ready", {}), true);
  const holder = {
    actor,
    session: {
      id: session,
      device: "command-cost-device",
      harness: "conformance",
      agent: actor.id,
    },
  };
  const subject = "command-cost:raw";
  const acquired = (await measure("lease.acquire", "claim", {
    subject,
    holder,
    ttlMs: 600_000,
    requestId: `cost-${++sequence}`,
  })) as { generation: number };
  await measure("lease.renew", "renew", {
    subject,
    holder,
    generation: acquired.generation,
    ttlMs: 900_000,
    requestId: `cost-${++sequence}`,
  });
  assert.equal(results.length, 12);
  console.log(
    `PASS command cost: ${size} source issues, 12 successful operations, four read-only checks`,
  );
}
