import { expect, spyOn, test } from "bun:test";
import { exitCode, failure } from "../../src/surface/result.ts";
import { evaluateMergeEvidence } from "../../cloud/src/merge-evidence.ts";
import { fixture, now } from "./merge-evidence.fixture.ts";
type Code = "INPUT_INVALID" | "UNAVAILABLE";
type Result =
  { ok: true; value: unknown } | { ok: false; code: Code; reason: string };
type Parser = {
  createGithubJsonBudget(): object;
  parseGithubJson(
    response: Response,
    budget: object,
    signal: AbortSignal,
  ): Promise<Result>;
};
const keys = (count: number) =>
  `{${Array(count).fill('"unknown":0').join(",")}}`;
const sized = (bytes: number) => JSON.stringify("é".repeat((bytes - 2) / 2));
type Row = [string, string | number, Code | null];
const rows: Row[] = [
  ["body", '""', null],
  ["body", '"end\\\\"', null],
  ["body", '"escaped\\"quote"', null],
  ["body", '"trailing\\', "UNAVAILABLE"],
  ["body", '"unfinished', "UNAVAILABLE"],
  [
    "body",
    JSON.stringify({
      text: 'colon: comma, quote" [ ]',
      value: [1, true, null],
    }),
    null,
  ],
  ...["", "{", "{} trailing", '"unterminated', "[1,]"].map((s): Row => [
    "body",
    s,
    "UNAVAILABLE",
  ]),
  ...["text/html", "application/jsonp", ""].map((s): Row => [
    "media",
    s,
    "UNAVAILABLE",
  ]),
  ["media", "Application/Vnd.Github+Json; charset=utf-8", null],
  ["utf8", 0, "UNAVAILABLE"],
  ["missing body", 0, "UNAVAILABLE"],
  ["bytes", 262144, null],
  ["bytes", 262145, "UNAVAILABLE"],
  ["aggregate bytes", 1048576, null],
  ["aggregate bytes", 1048577, "UNAVAILABLE"],
  ["keys", 16384, null],
  ["keys", 16385, "INPUT_INVALID"],
  ["aggregate keys", 16384, null],
  ["aggregate keys", 16385, "INPUT_INVALID"],
  ["document keys", 16384, null],
  ["document keys", 16385, "INPUT_INVALID"],
  ["merge page", 99, null],
  ["tiny chunks", 0, null],
  ["empty chunk", 0, "UNAVAILABLE"],
  ...[256, 257].flatMap((n): Row[] => [
    ["width", n, n === 256 ? null : "INPUT_INVALID"],
    ["array", n, n === 256 ? null : "INPUT_INVALID"],
  ]),
  ...[16, 17].map((n): Row => ["depth", n, n === 16 ? null : "INPUT_INVALID"]),
  // The 16,384-key budget makes the guard's 65,536-node ceiling unreachable for parsed JSON.
  ["guard", "nonfinite", "INPUT_INVALID"],
  ...["before", "during", "error", "stalled cancel"].map((s): Row => [
    "abort",
    s,
    "UNAVAILABLE",
  ]),
];
for (const [kind, value, code] of rows) {
  test(`${kind} ${value}`, async () => {
    const module = (await import("../../cloud/src/" + "github-json.ts").catch(
      () => null,
    )) as Parser | null;
    expect(typeof module?.parseGithubJson).toBe("function");
    expect(typeof module?.createGithubJsonBudget).toBe("function");
    const parser = module!,
      budget = parser.createGithubJsonBudget();
    const controller = new AbortController();
    let cancelled = 0,
      pulls = 0;
    const responses: Response[] = [];
    const bodies =
      kind === "aggregate bytes"
        ? [sized(262144), sized(262144), sized(262144), sized(262144)]
        : ["{}"];
    if (kind === "aggregate bytes" && value === 1048577) bodies.push("0");
    if (kind === "body") bodies[0] = String(value);
    if (kind === "bytes")
      bodies[0] = sized(262144) + (value === 262145 ? " " : "");
    if (kind === "keys") bodies[0] = keys(Number(value));
    if (kind === "document keys")
      bodies[0] = `[${Array.from({ length: 64 }, (_, i) =>
        JSON.stringify(
          Object.fromEntries(
            Array.from(
              { length: 255 + (i === 63 && value === 16385 ? 1 : 0) },
              (_, k) => [k, 0],
            ),
          ),
        ),
      ).join(",")}]`;
    const mergeFixture = fixture();
    if (kind === "merge page") {
      const checks = mergeFixture.observation.runs[0]!.checks;
      checks.splice(
        0,
        1,
        ...Array.from({ length: Number(value) }, (_, i) => ({
          ...checks[0]!,
          id: i + 1,
          name: i ? `extra-${i}` : "CI Gate",
        })),
      );
      bodies[0] = JSON.stringify(mergeFixture.observation);
    }
    if (kind === "aggregate keys")
      bodies.splice(0, 1, keys(8192), keys(Number(value) - 8192));
    if (kind === "width")
      bodies[0] = JSON.stringify(
        Object.fromEntries(
          Array.from({ length: Number(value) }, (_, i) => [i, 0]),
        ),
      );
    if (kind === "array")
      bodies[0] = JSON.stringify(Array(Number(value)).fill(0));
    if (kind === "depth")
      bodies[0] = "[".repeat(Number(value)) + "0" + "]".repeat(Number(value));
    if (value === "nonfinite") bodies[0] = "1e999";
    if (kind === "tiny chunks") bodies[0] = JSON.stringify("é".repeat(4096));
    if (value === "before") controller.abort("secret-sentinel");
    let result: Result | undefined;
    for (const body of bodies) {
      const bytes =
        kind === "utf8"
          ? new Uint8Array([34, 255, 34])
          : new TextEncoder().encode(body);
      const before = bytes.slice();
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(target) {
            pulls++;
            if (kind === "empty chunk") {
              target.enqueue(new Uint8Array());
              return;
            }
            if (value === "during" || value === "stalled cancel") {
              queueMicrotask(() => controller.abort("secret-sentinel"));
              return;
            }
            if (value === "error") {
              target.error(new Error("secret-sentinel raw-body"));
              return;
            }
            if (offset >= bytes.length) target.close();
            else
              target.enqueue(
                bytes.slice(
                  offset,
                  (offset += kind === "tiny chunks" ? 1 : 8191),
                ),
              );
          },
          cancel() {
            cancelled++;
            if (value === "stalled cancel") return new Promise<void>(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      const headers = new Headers({
        "Content-Type": kind === "media" ? String(value) : "application/json",
      });
      // Alternate absent and false lengths; neither controls streamed accounting.
      if (responses.length % 2 === 0) headers.set("Content-Length", "1");
      const response = new Response(kind === "missing body" ? null : stream, {
        headers,
      });
      responses.push(response);
      const race = kind === "tiny chunks" ? spyOn(Promise, "race") : null;
      try {
        result = await parser.parseGithubJson(
          response,
          budget,
          controller.signal,
        );
        if (race) expect(race.mock.calls.length).toBeLessThanOrEqual(1);
      } finally {
        race?.mockRestore();
      }
      expect(bytes).toEqual(before);
      expect(response.body?.locked ?? false).toBe(false);
      if (result.ok) expect(result.value).toEqual(JSON.parse(body));
    }
    expect(result?.ok).toBe(code === null);
    if (kind === "merge page" && result?.ok)
      expect(
        evaluateMergeEvidence(
          mergeFixture.policy,
          mergeFixture.expected,
          result.value,
          now,
        ).eligible,
      ).toBe(true);
    if (result && !result.ok) {
      expect(result.code === code).toBe(true);
      expect(Object.keys(result).sort()).toEqual(["code", "ok", "reason"]);
      expect(exitCode(failure(result.code, result.reason))).toBe(
        code === "INPUT_INVALID" ? 6 : 1,
      );
      expect(JSON.stringify(result)).not.toMatch(/secret-sentinel|raw-body/);
      const later = new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
      expect(
        await parser.parseGithubJson(
          later,
          budget,
          new AbortController().signal,
        ),
      ).toEqual(result);
      expect(later.bodyUsed).toBe(true);
    }
    if (value === "before") expect(pulls).toBe(0);
    if (value === "stalled cancel") expect(cancelled).toBe(1);
    if (
      value === "during" ||
      (kind === "bytes" && code) ||
      (kind === "aggregate bytes" && code)
    )
      expect(cancelled).toBeGreaterThan(0);
    expect(
      responses.every(
        (response) =>
          response.headers.get("Content-Type") ===
          (kind === "media" ? String(value) : "application/json"),
      ),
    ).toBe(true);
  }, 1000);
}
