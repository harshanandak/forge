import { expect, setDefaultTimeout, test } from "bun:test";
import { withGithubHttp } from "../../cloud/src/github-http.ts";
import type { MergeObservations } from "../../cloud/src/merge-evidence.ts";
setDefaultTimeout(1000);
type Session = Parameters<Parameters<typeof withGithubHttp>[2]>[0];
type Attempt = Omit<
  MergeObservations["runs"][number],
  "checks" | "completedAt"
> & { checkSuiteId: number };
type Reader = (
  s: Session,
  pr: { repositoryId: number; mergeSha: string | null },
) => Promise<
  { ok: true; value: Attempt[] } | { ok: false; code: string; reason: string }
>;
const merge = "b".repeat(40),
  digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const cases: [string, string, unknown, string | null][] = [
  ...["success", "failure", "cancelled", "queued", "in_progress"].map(
    (s): [string, string, unknown, null] => [s, "", null, null],
  ),
  ["empty", "", null, null],
  ["workflows", "", null, null],
  ["absent merge", "", null, "UNAVAILABLE"],
  ...Object.entries(
    JSON.parse(
      '{"latest":{"run_number":0,"run_attempt":0,"workflow_id":1.5,"path":"../ci.yml","head_sha":"bad","repository.id":8,"status":"unknown","conclusion":"unknown"},"second":{"id":11,"run_number":4,"run_attempt":1,"workflow_id":7,"path":".github/workflows/other.yml","head_sha":"bad","repository.id":8,"status":"queued","conclusion":"failure","check_suite_id":21},"suite":{"id":21,"head_sha":"bad","repository.id":8,"app.id":0},"content":{"type":"dir","path":"other","encoding":"none","content":"***","size":4}}',
    ) as Record<string, Record<string, unknown>>,
  ).flatMap(([group, fields]) =>
    Object.entries(fields).map(([k, v]): [string, string, unknown, string] => [
      group,
      `${group}.${k}`,
      v,
      group === "content" ? "UNAVAILABLE" : "INPUT_INVALID",
    ]),
  ),
  ...[
    "count drift",
    "incomplete",
    "full",
    "later failure",
    "request cap",
    "missing suite",
  ].map((s): [string, string, unknown, string] => [s, "", null, "UNAVAILABLE"]),
  ["duplicate", "", null, "INPUT_INVALID"],
];
for (const [name, path, replacement, code] of cases)
  test(`${name}:${path}`, async () => {
    const module = (await import(
      "../../cloud/src/" + "github-workflow-evidence.ts"
    ).catch(() => null)) as { readGithubWorkflowEvidence?: Reader } | null;
    expect(typeof module?.readGithubWorkflowEvidence).toBe("function");
    const base = JSON.parse(
      `{"id":10,"run_number":3,"run_attempt":2,"workflow_id":9,"path":".github/workflows/ci.yml","head_sha":"${merge}","repository":{"id":7},"check_suite_id":20,"status":"completed","conclusion":"success"}`,
    ) as Record<string, unknown>;
    if (["failure", "cancelled", "queued", "in_progress"].includes(name)) {
      base.status = ["queued", "in_progress"].includes(name)
        ? name
        : "completed";
      base.conclusion = base.status === "completed" ? name : null;
    }
    if (name === "request cap") base.run_attempt = 40;
    const fixture = {
      latest: structuredClone(base),
      second: structuredClone(base),
      suite: JSON.parse(
        `{"id":20,"head_sha":"${merge}","repository":{"id":7},"app":{"id":77}}`,
      ) as Record<string, unknown>,
      content: JSON.parse(
        '{"type":"file","path":".github/workflows/ci.yml","encoding":"base64","content":"YWJj\\n","size":3,"sha":"ffffffffffffffffffffffffffffffffffffffff","download_url":"https://evil.test/secret"}',
      ) as Record<string, unknown>,
    };
    if (path) {
      const keys = path.split(".");
      let at = fixture as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1))
        at = at[key] as Record<string, unknown>;
      at[keys.at(-1)!] = replacement;
    }
    const before = structuredClone(fixture),
      urls: string[] = [];
    let cleared = 0;
    const outer = await withGithubHttp(
      JSON.parse(
        '{"owner":"acme","repo":"forge","repositoryId":7,"prNumber":9,"branch":"main"}',
      ),
      {
        signal: new AbortController().signal,
        now: () => 1000,
        deadline: () => () => {
          cleared++;
        },
        credential: () =>
          Promise.resolve({
            token: "credential-sentinel",
            expiresAt: 9999,
          }),
        fetch: (url, init) => {
          urls.push(url);
          const u = new URL(url),
            p = u.pathname;
          expect(u.origin).toBe("https://api.github.com");
          expect(init.method).toBe("GET");
          expect(init.redirect).toBe("manual");
          expect(new Headers(init.headers).get("Authorization")).toBe(
            "Bearer credential-sentinel",
          );
          let body: unknown;
          if (p.endsWith("/actions/runs")) {
            expect([...u.searchParams]).toEqual([
              ["head_sha", merge],
              ["per_page", "100"],
            ]);
            const rows =
              name === "empty"
                ? []
                : name === "duplicate"
                  ? [fixture.latest, fixture.latest]
                  : name === "full"
                    ? Array.from({ length: 100 }, (_, i) => ({
                        ...fixture.latest,
                        id: i + 1,
                      }))
                    : name === "workflows"
                      ? [
                          fixture.latest,
                          { ...fixture.latest, id: 11, workflow_id: 10 },
                        ]
                      : [fixture.latest];
            body = {
              workflow_runs: rows,
              total_count: rows.length + (name === "count drift" ? 1 : 0),
              incomplete_results: name === "incomplete",
            };
          } else if (p.includes("/contents/")) {
            expect(p).toBe(
              "/repos/acme/forge/contents/.github/workflows/ci.yml",
            );
            expect(u.searchParams.get("ref")).toBe(merge);
            body = fixture.content;
          } else if (p.includes("/attempts/")) {
            const attempt = Number(p.split("/").at(-1));
            if (name === "later failure" && attempt === 2)
              throw new Error("credential-sentinel upstream-sentinel");
            body =
              attempt === 2 && name !== "request cap"
                ? fixture.second
                : {
                    ...base,
                    run_attempt: attempt,
                    status: "completed",
                    conclusion: "success",
                  };
            if (name === "workflows" && p.split("/").at(-3) === "11")
              Object.assign(body as object, { id: 11, workflow_id: 10 });
          } else if (p.split("/").at(-2) === "check-suites")
            body = name === "missing suite" ? null : fixture.suite;
          else if (p.endsWith("/probe")) body = {};
          else throw new Error("Unexpected endpoint");
          return Promise.resolve(
            new Response(JSON.stringify(body), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        },
      },
      async (session) => {
        const result = await module!.readGithubWorkflowEvidence!(session, {
          repositoryId: 7,
          mergeSha: name === "absent merge" ? null : merge,
        });
        if (result.ok) await session.get(["probe"]);
        return result;
      },
    );
    const result = outer.ok ? outer.value : outer;
    expect(result.ok).toBe(code === null);
    if (result.ok) {
      expect(result.value).toHaveLength(
        name === "empty" ? 0 : name === "workflows" ? 4 : 2,
      );
      for (const [i, run] of result.value.entries()) {
        expect<unknown>(run).toEqual({
          ...(JSON.parse(
            `{"repositoryId":7,"appId":77,"workflowId":${i < 2 ? 9 : 10},"workflowPath":".github/workflows/ci.yml","workflowDigest":"${digest}","id":${i < 2 ? 10 : 11},"runNumber":3,"headSha":"${merge}","checkSuiteId":20}`,
          ) as Record<string, unknown>),
          attempt: (i % 2) + 1,
          status: i === 0 ? "completed" : base.status,
          conclusion: i === 0 ? "success" : base.conclusion,
        });
      }
      expect(urls.at(-1)).toBe("https://api.github.com/repos/acme/forge/probe");
    } else {
      expect(code).toBe(result.code);
      expect(Object.keys(result).sort()).toEqual(["code", "ok", "reason"]);
    }
    expect(JSON.stringify(result)).not.toMatch(
      /credential-sentinel|upstream-sentinel|evil\.test/,
    );
    expect(fixture).toEqual(before);
    expect(cleared).toBe(1);
    expect(urls.length).toBeLessThanOrEqual(32);
  });
