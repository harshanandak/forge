import { expect, setDefaultTimeout, test } from "bun:test";
import { fail, ok } from "../../../tools/ci/review-gate-reader/result.ts";
import { uint } from "../../../tools/ci/review-gate-reader/strict-json.ts";
import {
  getJson,
  type TransportResponse,
} from "../../../tools/ci/review-gate-reader/transport.ts";
import { fakeTransport, response } from "./transport-fixture.ts";

setDefaultTimeout(1000);

const path = "/repos/o/r/x";
const body = '{"a":1}';

async function getOnce(reply: TransportResponse, throwOn?: number) {
  const { transport, calls } = fakeTransport({ [path]: reply }, throwOn);
  const result = await getJson(transport, path, { a: uint });
  expect(calls).toEqual([{ method: "GET", path, argc: 1 }]);
  return result;
}

test("T1 and T7 status 200 uses one GET with only the path", async () => {
  expect(await getOnce(response(body))).toEqual(ok({ a: 1 }));
});

test.each([
  ...[201, 204, 301, 304, 401, 404].map(
    (status) => ["T2", status, undefined, "http_status"] as const,
  ),
  ["T3", 403, "0", "api_rate_limited"],
  ["T3", 429, undefined, "api_rate_limited"],
  ["T4", 403, "4", "http_status"],
  ["T4", 403, undefined, "http_status"],
  ["T4", 502, undefined, "http_status"],
] as const)(
  "%s refuses HTTP %i with remaining %s",
  async (id, status, remaining, reason) => {
    const headers = remaining ? { "x-ratelimit-remaining": remaining } : {};
    const reply = response(id === "T4" ? "not json" : body, status, headers);
    expect(await getOnce(reply)).toEqual(fail(reason, path));
  },
);

test("T5 reports thrown transport failure without its message", async () => {
  const result = await getOnce(response(body), 1);
  expect(result).toEqual(fail("network_error", path));
  expect(JSON.stringify(result)).not.toContain("ghp_test_token");
});

test.each([
  ["not json", "json_invalid", "$"],
  ['{"a":"x"}', "api_field_invalid", "$.a"],
] as const)("T6 includes the JSON path for %j", async (text, reason, where) => {
  expect(await getOnce(response(text))).toEqual(
    fail(reason, `${path}#${where}`),
  );
});
