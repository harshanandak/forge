import { expect, setDefaultTimeout, test } from "bun:test";
import { evaluateMergeEvidence } from "../../cloud/src/merge-evidence.ts";
import type { MergeObservations } from "../../cloud/src/merge-evidence.ts";
import type { withGithubHttp } from "../../cloud/src/github-http.ts";
setDefaultTimeout(1500);
type Reader = (
  input: unknown,
  ports: Parameters<typeof withGithubHttp>[1],
) => Promise<
  | { ok: true; value: MergeObservations }
  | { ok: false; code: string; reason: string }
>;
const head = "a".repeat(40),
  merge = "b".repeat(40),
  time = "2026-01-01T00:00:00Z";
const digest =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const rows: [string, string, unknown, string | null][] = [
  ..."ok squash failure cancelled queued missing-check wrong-producer not-ancestor mixed-case"
    .split(" ")
    .map((n): [string, string, unknown, null] => [n, "", null, null]),
  ...Object.entries(
    JSON.parse(
      '{"job.run_id":99,"job.run_attempt":1,"job.head_sha":"bad","job.name":"other","check.id":99,"check.app.id":99,"check.check_suite.id":99,"check.head_sha":"bad","check.status":"unknown","check.conclusion":"unknown","check.completed_at":"2030-01-01T00:00:00Z"}',
    ) as Record<string, unknown>,
  ).map(([p, v]): [string, string, unknown, string] => [
    "malformed",
    p,
    v,
    "INPUT_INVALID",
  ]),
  ...[
    "https://evil.test/42",
    "https://api.github.com/repos/other/repo/check-runs/42",
    "https://api.github.com/repos/acme/forged/check-runs/42",
    "https://api.github.com/repos/acme/forge/check-runs/42?token=secret",
    null,
  ].map((v): [string, string, unknown, string] => [
    "join",
    "job.check_run_url",
    v,
    "UNAVAILABLE",
  ]),
  ..."jobs-count jobs-count-missing runs-count-missing jobs-full duplicate-check later-check pr-changed normalized server-budget run-advanced run-status run-added"
    .split(" ")
    .map((n): [string, string, unknown, string] => [
      n,
      "",
      null,
      ["duplicate-check", "pr-changed", "normalized", "server-budget"].includes(
        n,
      )
        ? "INPUT_INVALID"
        : "UNAVAILABLE",
    ]),
];
for (const [name, path, value, code] of rows)
  test(`${name}:${path}:${JSON.stringify(value)}`, async () => {
    const module = (await import(
      "../../cloud/src/" + "github-evidence.ts"
    )) as { readGithubMergeEvidence?: Reader };
    expect(typeof module.readGithubMergeEvidence).toBe("function");
    const actual = name === "squash" ? merge : head;
    const input = JSON.parse(
      `{"locator":{"owner":"acme","repo":"forge","repositoryId":7,"branch":"main","prNumber":9},"policy":{"project":"forge","repositoryId":7,"baseBranch":"main","version":"1","digest":"${"d".repeat(64)}","producer":{"repositoryId":7,"appId":77,"workflowId":9,"workflowPath":".github/workflows/ci.yml","workflowDigest":"${digest}"},"requiredChecks":["ci"]},"binding":{"project":"forge","issueId":"work-1","linkKey":"link:work-1:1","linkRevision":1,"repositoryId":7,"prNumber":9,"prId":"PR_node","headSha":"${head}"}}`,
    ) as Record<string, unknown>;
    if (name === "mixed-case")
      Object.assign(input.locator as object, { owner: "AcMe", repo: "FoRgE" });
    const fixture = JSON.parse(
      `{"pr":{"number":9,"node_id":"PR_node","head":{"sha":"${head}"},"base":{"repo":{"id":7},"ref":"main"},"state":"closed","merged":true,"merged_at":"${time}","merge_commit_sha":"${actual}"},"job":{"id":50,"run_id":10,"run_attempt":2,"head_sha":"${actual}","check_run_url":"https://api.github.com/repos/acme/forge/check-runs/42","name":"ci","status":"completed","conclusion":"success","completed_at":"${time}"},"check":{"id":42,"app":{"id":77},"check_suite":{"id":20},"head_sha":"${actual}","name":"ci","status":"completed","conclusion":"success","completed_at":"${time}"}}`,
    ) as Record<string, Record<string, unknown>>;
    if (path) {
      const keys = path.split(".");
      let at = fixture as Record<string, unknown>;
      for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
      at[keys.at(-1)!] = value;
    }
    if (name === "server-budget" || name === "normalized")
      (input.policy as Record<string, unknown>).requiredChecks = Array.from(
        { length: 256 },
        (_, i) => `${i}${"😀".repeat(name === "server-budget" ? 126 : 125)}`,
      );
    const inputBytes = new TextEncoder().encode(JSON.stringify(input)).length;
    if (name === "server-budget")
      expect(inputBytes).toBeGreaterThan(128 * 1024);
    if (name === "normalized")
      expect(inputBytes).toBeLessThanOrEqual(128 * 1024);
    const before = structuredClone({ input, fixture }),
      urls: string[] = [];
    let prReads = 0,
      runLists = 0,
      credentials = 0;
    const result = await module.readGithubMergeEvidence!(input, {
      now: () => Date.parse(time),
      signal: new AbortController().signal,
      deadline: () => () => {},
      credential: () => {
        credentials++;
        return Promise.resolve({
          token: "credential-sentinel",
          expiresAt: Date.parse(time) + 1000,
        });
      },
      fetch: (url, init) => {
        urls.push(url);
        const u = new URL(url),
          parts = u.pathname.split("/");
        expect(u.origin).toBe("https://api.github.com");
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("manual");
        let body: unknown;
        if (parts.includes("pulls")) {
          prReads++;
          body =
            name === "pr-changed" && prReads === 2
              ? { ...fixture.pr, node_id: "changed" }
              : fixture.pr;
        } else if (parts.includes("git"))
          body = {
            ref: "refs/heads/main",
            object: {
              type: "commit",
              sha: name === "not-ancestor" ? merge : actual,
            },
          };
        else if (parts.includes("compare"))
          body = {
            base_commit: { sha: actual },
            merge_base_commit: {
              sha: name === "not-ancestor" ? merge : actual,
            },
            status: name === "not-ancestor" ? "behind" : "identical",
            ahead_by: 0,
            behind_by: name === "not-ancestor" ? 1 : 0,
          };
        else if (parts.includes("contents")) {
          expect(u.searchParams.get("ref")).toBe(actual);
          body = {
            type: "file",
            path: ".github/workflows/ci.yml",
            encoding: "base64",
            content: "YWJj",
            size: 3,
          };
        } else if (parts.includes("check-suites"))
          body = {
            id: 20,
            head_sha: actual,
            repository: { id: 7 },
            app: { id: name === "wrong-producer" ? 78 : 77 },
          };
        else if (parts.includes("check-runs")) {
          const id = Number(parts.at(-1));
          if (name === "later-check" && id === 42)
            throw new Error("credential-sentinel upstream-sentinel");
          body = {
            ...fixture.check,
            id:
              name === "malformed" && path === "check.id"
                ? fixture.check!.id
                : id,
            app: {
              id:
                name === "wrong-producer"
                  ? 78
                  : (fixture.check!.app as { id: number }).id,
            },
          };
          if (id === 41)
            body = {
              ...(body as object),
              status: "completed",
              conclusion: "success",
              completed_at: time,
            };
        } else if (parts.at(-1) === "jobs") {
          expect(u.searchParams.get("per_page")).toBe("100");
          expect(u.searchParams.has("page")).toBe(false);
          const attempt = Number(parts.at(-2)),
            count =
              name === "jobs-full"
                ? 100
                : name === "duplicate-check"
                  ? 2
                  : name === "missing-check"
                    ? 0
                    : 1;
          const jobs = Array.from({ length: count }, (_, i) => ({
            ...fixture.job,
            id: 50 + i,
            run_attempt:
              name === "malformed" && path === "job.run_attempt" ? 1 : attempt,
            check_run_url:
              path === "job.check_run_url"
                ? value
                : `https://api.github.com/repos/acme/forge/check-runs/${name === "duplicate-check" ? 42 : attempt === 1 ? 41 : 42}`,
          }));
          body = {
            jobs,
            total_count: jobs.length + (name === "jobs-count" ? 1 : 0),
          };
          if (name === "jobs-count-missing")
            delete (body as Record<string, unknown>).total_count;
        } else if (parts.includes("actions")) {
          const collection = parts.at(-1) === "runs",
            current = collection && ++runLists === 2;
          const attempt = parts.includes("attempts") ? Number(parts.at(-1)) : 2;
          const run = {
            id: 10,
            repository: { id: 7 },
            run_number: 3,
            run_attempt: attempt,
            workflow_id: 9,
            path: ".github/workflows/ci.yml",
            head_sha: actual,
            check_suite_id: 20,
            status: attempt === 2 && name === "queued" ? "queued" : "completed",
            conclusion:
              attempt === 2 && name === "queued"
                ? null
                : attempt === 2 && ["failure", "cancelled"].includes(name)
                  ? name
                  : "success",
          };
          body = parts.includes("attempts")
            ? run
            : { workflow_runs: [run], total_count: 1 };
          if (current) {
            expect(
              urls.filter((url) => new URL(url).pathname.endsWith("/jobs")),
            ).toHaveLength(2);
            if (name !== "missing-check")
              expect(urls.at(-2)?.endsWith("/42")).toBe(true);
            if (name === "run-advanced") run.run_attempt = 3;
            if (name === "run-status") {
              run.status = "in_progress";
              run.conclusion = null;
            }
            if (name === "run-added")
              body = {
                workflow_runs: [
                  run,
                  {
                    ...run,
                    id: 11,
                    run_number: 4,
                    run_attempt: 1,
                    check_suite_id: 21,
                    status: "in_progress",
                    conclusion: null,
                  },
                ],
                total_count: 2,
              };
          }
          if (collection) {
            expect([...u.searchParams]).toEqual([
              ["head_sha", actual],
              ["per_page", "100"],
            ]);
            if (name === "runs-count-missing")
              delete (body as Record<string, unknown>).total_count;
          }
        } else throw new Error("Unexpected endpoint");
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      },
    });
    expect(result.ok).toBe(code === null);
    if (result.ok) {
      expect(result.value.completeness).toBe("complete");
      expect<unknown>(result.value.binding).toEqual(input.binding);
      expect(result.value.finalPr.mergeSha).toBe(actual);
      expect(result.value.finalPr.headSha).toBe(head);
      expect(result.value.runs.map((r) => r.attempt)).toEqual([1, 2]);
      expect(result.value.runs.map((r) => r.checks.map((c) => c.id))).toEqual(
        name === "missing-check" ? [[], []] : [[41], [42]],
      );
      expect(
        result.value.runs.every(
          (r) =>
            r.workflowDigest === digest &&
            !Object.hasOwn(r, "completedAt") &&
            !Object.hasOwn(r, "checkSuiteId"),
        ),
      ).toBe(true);
      const eligible = evaluateMergeEvidence(
        input.policy,
        input.binding,
        result.value,
        time,
      );
      expect(eligible.eligible).toBe(
        ["ok", "squash", "mixed-case"].includes(name),
      );
      if (!eligible.eligible)
        expect(eligible.code).toBe(
          name === "queued"
            ? "UNAVAILABLE"
            : name === "not-ancestor"
              ? "PR_NOT_MERGED"
              : "RECEIPT_INVALID",
        );
      expect(urls.at(-1)).toBe(
        `https://api.github.com/repos/${name === "mixed-case" ? "AcMe/FoRgE" : "acme/forge"}/pulls/9`,
      );
      expect(prReads).toBe(2);
      expect(runLists).toBe(2);
    } else {
      expect(code).toBe(result.code);
      expect(Object.keys(result).sort()).toEqual(["code", "ok", "reason"]);
    }
    if (name === "server-budget") expect(credentials).toBe(0);
    if (name === "normalized") expect(credentials).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(
      /credential-sentinel|upstream-sentinel/,
    );
    expect({ input, fixture }).toEqual(before);
  });
