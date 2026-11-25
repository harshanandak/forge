import { expect, setDefaultTimeout, test } from "bun:test";
import {
  fileName,
  numericId,
  readPages,
} from "../../../tools/ci/review-gate-reader/pages.ts";
import { fail, ok } from "../../../tools/ci/review-gate-reader/result.ts";
import {
  open,
  str,
  uint,
} from "../../../tools/ci/review-gate-reader/strict-json.ts";
import { fakeTransport, origin, response } from "./transport-fixture.ts";

setDefaultTimeout(1000);

const first = "/x";
const second = "/x?page=2";
const third = "/x?page=3";
const next = (path: string) => `<${origin}${path}>; rel="next"`;
const ids = (...values: number[]) => values.map((id) => ({ id }));
const page = (items: unknown[], link?: string) =>
  response(JSON.stringify(items), 200, link === undefined ? {} : { link });
const idItem = open({ id: uint });
const fileItem = open({ filename: str, sha: str });
const countIds = (count: number) =>
  ids(...Array.from({ length: count }, (_, index) => index + 1));
const incomplete = fail("pages_incomplete", first);
const firstPage = page(ids(1), next(second));

function readIds(
  replies: Parameters<typeof fakeTransport>[0],
  throwOn?: number,
) {
  const { transport, calls } = fakeTransport(replies, throwOn);
  return { calls, result: readPages(transport, first, idItem, numericId) };
}

test("P1 collects 101 items in order", async () => {
  const start = page(countIds(100), next(second));
  const end = page(ids(101));
  const { result, calls } = readIds({ [first]: start, [second]: end });
  expect(await result).toEqual(ok(countIds(101)));
  expect(calls).toEqual(
    [first, second].map((path) => ({ method: "GET", path, argc: 1 })),
  );
});

test.each([
  undefined,
  `<${origin}/x?page=1>; rel="prev", <${origin}/x>; rel="first"`,
])("P2 treats a page without next as terminal %j", async (link) => {
  const { result, calls } = readIds({ [first]: page([], link) });
  expect(await result).toEqual(ok([]));
  expect(calls).toHaveLength(1);
});

test("P3 stops at 100 pages when another page is advertised", async () => {
  const { result, calls } = readIds((_path, call) =>
    page(ids(call), next(`/x?page=${call + 1}`)),
  );
  expect(await result).toEqual(incomplete);
  expect(calls).toHaveLength(100);
});

test.each([
  ["P5 cross-origin URL", '<https://example.invalid/x>; rel="next"'],
  ["P6 garbage Link", "garbage"],
  ["P6 missing rel", `<${origin}${second}>`],
  ["P6 two next links", `${next(second)}, ${next(third)}`],
])("%s", async (_name, link) => {
  const { result, calls } = readIds({ [first]: page(ids(1), link) });
  expect(await result).toEqual(incomplete);
  expect(calls.map(({ path }) => path)).toEqual([first]);
});

test.each([
  ["P4 repeated page URL", page(ids(2), next(first))],
  ["P7 repeated id across pages", page(ids(100))],
] as const)("%s", async (_name, end) => {
  const start = page(ids(100), next(second));
  const { result, calls } = readIds({ [first]: start, [second]: end });
  expect(await result).toEqual(incomplete);
  expect(calls.map(({ path }) => path)).toEqual([first, second]);
});

test("P7 repeated id within a page", async () => {
  const { result } = readIds({ [first]: page(ids(5, 5)) });
  expect(await result).toEqual(incomplete);
});

test.each([304, 201, 502, 429])(
  "P8/P9 refuse later HTTP %i",
  async (status) => {
    const end = response('[{"id":2}]', status);
    const { result, calls } = readIds({ [first]: firstPage, [second]: end });
    const reason = status === 429 ? "api_rate_limited" : "http_status";
    expect(await result).toEqual(fail(reason, second));
    expect(calls).toHaveLength(2);
  },
);

test("P8 refuses a thrown third page without a partial list", async () => {
  const middle = page(ids(2), next(third));
  const replies = { [first]: firstPage, [second]: middle };
  const { result, calls } = readIds(replies, 3);
  expect(await result).toEqual(fail("network_error", third));
  expect(calls).toHaveLength(3);
});

test.each([
  ["[{}]", "api_field_invalid", "$[0].id"],
  ['[{"id":"1"}]', "api_field_invalid", "$[0].id"],
  ["{}", "json_invalid", "$"],
] as const)("P10 refuses invalid id stream %j", async (body, reason, where) => {
  const { result } = readIds({ [first]: response(body) });
  expect(await result).toEqual(fail(reason, `${first}#${where}`));
});

test.each(['[{"sha":"s1"}]', '[{"filename":"","sha":"s1"}]'])(
  "P10 refuses missing or empty filename %j",
  async (body) => {
    const { transport } = fakeTransport({ [first]: response(body) });
    const result = await readPages(transport, first, fileItem, fileName);
    expect(result).toEqual(fail("api_field_invalid", `${first}#$[0].filename`));
  },
);

const added = { filename: "a.ts", sha: "s1", status: "added" };
const modified = { filename: "b.ts", sha: "s2", status: "modified" };

test("P11 collects files without numeric ids", async () => {
  const { transport, calls } = fakeTransport({
    [first]: page([added], next(second)),
    [second]: page([modified]),
  });
  const item = open({ filename: str, sha: str, status: str });
  const result = await readPages(transport, first, item, fileName);
  expect(result).toEqual(ok([added, modified]));
  expect(calls).toHaveLength(2);
});

test("P12 retains distinct filenames with the same blob SHA", async () => {
  const items = [
    { filename: "a.ts", sha: "s1" },
    { filename: "b.ts", sha: "s1" },
  ];
  const { transport, calls } = fakeTransport({ [first]: page(items) });
  const result = await readPages(transport, first, fileItem, fileName);
  expect(result).toEqual(ok(items));
  expect(calls).toHaveLength(1);
});

test("P13 refuses the same filename across pages", async () => {
  const { transport } = fakeTransport({
    [first]: page([added], next(second)),
    [second]: page([{ ...modified, filename: added.filename }]),
  });
  const result = await readPages(transport, first, fileItem, fileName);
  expect(result).toEqual(incomplete);
});
