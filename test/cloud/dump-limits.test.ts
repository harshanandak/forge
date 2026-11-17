import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { limitsFrom } from "../../cloud/src/dump.ts";
import { fixture, pages, projection } from "./dump-capacity.fixture.ts";

const maximum = { pageBytes: 4_194_304, maxBytes: 67_108_864, maxRows: 30_000 };
const names = ["DUMP_PAGE_BYTES", "DUMP_MAX_BYTES", "DUMP_MAX_ROWS"] as const;
for (const value of [
  undefined,
  0,
  -1,
  1.5,
  "invalid",
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
])
  test(`invalid dump limits ${String(value)} use bounded defaults`, () => {
    assert.deepEqual(
      limitsFrom(Object.fromEntries(names.map((n) => [n, value]))),
      maximum,
    );
  }, 10_000);

for (const value of [1, "1", Number.MAX_SAFE_INTEGER])
  test(`valid dump limits ${value} stay inside each fixed ceiling`, () => {
    const limits = limitsFrom(Object.fromEntries(names.map((n) => [n, value])));
    assert.deepEqual(
      Object.values(limits),
      Object.values(maximum).map((cap) => Math.min(Number(value), cap)),
    );
  }, 10_000);

test("the example pins the measured dump limits", () => {
  const config = readFileSync(
    new URL("../../cloud/wrangler.example.jsonc", import.meta.url),
    "utf8",
  );
  for (const [name, cap] of [
    ["DUMP_MAX_ROWS", maximum.maxRows],
    ["DUMP_MAX_BYTES", maximum.maxBytes],
  ] as const)
    assert.match(config, new RegExp(`"${name}": "${cap}"`));
}, 10_000);

for (const resource of ["rows", "bytes"])
  test(`oversized configured ${resource} refuse export and staged import past the fixed ceiling`, async () => {
    const extra = {
      DUMP_MAX_ROWS: String(Number.MAX_SAFE_INTEGER),
      DUMP_MAX_BYTES: String(Number.MAX_SAFE_INTEGER),
    };
    const source = await fixture("export", true, false, extra);
    if (resource === "rows") source.seed("state_events", maximum.maxRows + 1);
    else source.pad(maximum.maxBytes + 1);
    const target = await fixture(undefined, false, false, extra);
    let refused = false;
    await pages(source, async (page) => {
      if (refused) return;
      const reply = await target.send("restore", page);
      if (!reply.ok) {
        assert.deepEqual(projection(reply), ["FAIL", 1, "RESTORE_TOO_LARGE"]);
        refused = true;
      }
    });
    assert.equal(refused, true);
    assert.ok(Object.values(target.usage().rows).every((n) => n === 0));
    const exportSource = await fixture(undefined, true, false, extra);
    if (resource === "rows")
      exportSource.seed("state_events", maximum.maxRows + 1);
    else exportSource.pad(maximum.maxBytes + 1);
    const before = exportSource.snapshot();
    const reply = await exportSource.send("dump?cursor=start");
    assert.deepEqual(projection(reply), ["FAIL", 1, "DUMP_TOO_LARGE"]);
    assert.match(reply.error.message, /over the .* limit/);
    assert.deepEqual(exportSource.snapshot(), before);
  }, 60_000);
