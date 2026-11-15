import assert from "node:assert/strict";
import { spyOn, test } from "bun:test";
import { roundTrip } from "../../cloud/conformance/conformance.ts";
import { COLUMNS, TABLES, type Table } from "../../cloud/conformance/digest.ts";

type Row = Record<string, string | number>;
const tables = () =>
  Object.fromEntries(
    TABLES.map((table) => [
      table,
      [
        Object.fromEntries<string | number>(
          COLUMNS[table].map((column) => [
            column,
            ["sequence", "revision", "generation"].includes(column)
              ? 1
              : 'source é€\\"',
          ]),
        ),
      ],
    ]),
  ) as Record<Table, Row[]>;
const page = (rows: Record<Table, Row[]>) => ({
  format: "forge-cloud-dump-page/2",
  page: 0,
  last: true,
  next: null,
  tables: rows,
});

// The transport supplies the bytes, acknowledgements and provision state independently of the checker.
// Mutations reach its comparison, without involving a product parser that could reject them first.
async function compare(
  change: (rows: Record<Table, Row[]>) => void,
  wire = (text: string) => text,
) {
  const source = tables(),
    target = tables();
  change(target);
  let restored = false;
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        await Promise.resolve();
        assert.ok(typeof input === "string");
        const request = new Request(input, init),
          url = new URL(request.url);
        if (url.pathname.endsWith("/status"))
          return Response.json({ ok: true, value: { initialized: restored } });
        if (request.method === "POST") {
          restored = true;
          return Response.json({
            ok: true,
            value: {
              page: 0,
              done: true,
              restored: Object.fromEntries(TABLES.map((table) => [table, 1])),
            },
          });
        }
        const isTarget = url.pathname.includes("/target/");
        const text = JSON.stringify({
          ok: true,
          value: page(isTarget ? target : source),
        });
        // Byte-sized chunks split every multibyte UTF-8 sequence and escaped string.
        const bytes = Buffer.from(isTarget ? wire(text) : text);
        let at = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (at === bytes.length) controller.close();
              else controller.enqueue(bytes.subarray(at, ++at));
            },
          }),
        );
      },
      { preconnect: () => {} },
    ),
  );
  try {
    return await roundTrip("source", "target", "bounded image", 4096);
  } finally {
    transport.mockRestore();
  }
}

test.each(TABLES)(
  "bounded image rejects a dropped row in %s",
  async (table) => {
    await assert.rejects(
      () =>
        compare((rows) => {
          rows[table] = [];
        }),
      new RegExp(table),
    );
  },
  5000,
);

test.each([
  ["state_records", "body"],
  ["state_requests", "result"],
  ["domain_cloud_command_receipts", "created_at"],
  ["domain_cloud_command_receipts", "fingerprint"],
] as const)(
  "bounded image rejects a same-length changed %s.%s",
  async (table, column) => {
    await assert.rejects(
      () =>
        compare((rows) => {
          rows[table][0]![column] = String(rows[table][0]![column]).replace(
            "source",
            "sourcf",
          );
        }),
      new RegExp(table),
    );
  },
  5000,
);

test("bounded image accepts transport property ordering alone", async () => {
  await assert.doesNotReject(() =>
    compare((rows) => {
      for (const table of TABLES)
        rows[table] = rows[table].map((row) =>
          Object.fromEntries(Object.entries(row).reverse()),
        );
    }),
  );
}, 5000);

test("bounded image rejects duplicate JSON keys before comparing", async () => {
  await assert.rejects(
    () =>
      compare(
        () => {},
        (text) => text.replace('"page":0,', '"page":0,"page":0,'),
      ),
    /duplicate|invalid.*image/i,
  );
}, 5000);

test("bounded image requires an empty table array", async () => {
  await assert.rejects(
    () =>
      compare(
        (rows) => {
          rows.state_leases = [];
        },
        (text) => text.replace('"state_leases":[],', ""),
      ),
    /state_leases|table|schema/i,
  );
}, 5000);
