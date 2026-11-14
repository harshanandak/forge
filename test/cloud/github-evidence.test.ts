import { expect, setDefaultTimeout, test } from "bun:test";
import type { MergeObservations } from "../../cloud/src/merge-evidence.ts";
import { withGithubHttp } from "../../cloud/src/github-http.ts";
setDefaultTimeout(1000);
type Facts = Pick<
  MergeObservations,
  "binding" | "initialPr" | "finalPr" | "targetTip" | "ancestry"
>;
type Reader = (
  input: unknown,
  ports: Parameters<typeof withGithubHttp>[1],
  read: (
    s: Parameters<Parameters<typeof withGithubHttp>[2]>[0],
    pr: Facts["initialPr"],
  ) => Promise<string>,
) => Promise<
  | { ok: true; value: Facts & { evidence: string } }
  | { ok: false; code: string; reason: string }
>;
const head = "a".repeat(40),
  merge = "b".repeat(40),
  tip = "c".repeat(40),
  time = "2026-01-01T00:00:00Z";
type Row = [string, string, unknown];
const cases: Row[] = [
  ..."ok squash behind diverged identical partial extension accessor clock"
    .split(" ")
    .map((v) => [v, "", null] as Row),
  ...Object.entries(
    JSON.parse(
      '{"policy":null,"binding":[],"policy.project":"bad/project","policy.repositoryId":8,"policy.baseBranch":"other","policy.version":"","policy.digest":"bad","policy.producer.appId":0,"policy.producer.workflowId":1.5,"policy.producer.repositoryId":8,"policy.producer.workflowPath":"../ci.yml","policy.producer.workflowDigest":"bad","policy.requiredChecks":[],"binding.project":"other","binding.repositoryId":8,"binding.prNumber":10,"binding.prId":"","binding.headSha":"bad","binding.issueId":"forge-1","binding.linkKey":"link:work-2:1","binding.linkRevision":-1,"policy.extra":"unknown","locator.host":"evil.test"}',
    ) as Record<string, unknown>,
  ).map(([p, v]) => ["input", `input.${p}`, v] as Row),
  ["input", "input.policy.requiredChecks", ["ci", "ci"]],
  ["input", "input.policy.requiredChecks", [7]],
  ...Object.entries({
    "base.repo.id": 8,
    number: 10,
    node_id: "other",
    "head.sha": merge,
    "base.ref": "other",
    state: "open",
    merge_commit_sha: tip,
    merged_at: "2025-12-31T00:00:00Z",
  }).map(([p, v]) => ["changed", `last.${p}`, v] as Row),
  ...Object.entries({
    "head.sha": "bad",
    "base.repo.id": 0,
    state: "unknown",
    merged_at: "2026-02-30T00:00:00Z",
    merged: false,
  }).map(([p, v]) => ["bad", `first.${p}`, v] as Row),
  ["bad", "first.merged_at", "2030-01-01T00:00:00Z"],
  ["bad", "branch.object.sha", "bad"],
  [
    "branch-guard",
    "branch",
    [
      {
        ref: "refs/heads/feature/a-extra",
        object: { type: "commit", sha: tip },
      },
    ],
  ],
  ["branch-guard", "branch.ref", "refs/heads/feature/a-extra"],
  ["branch-guard", "branch.object.type", "tag"],
  ["bad", "comparison.base_commit.sha", merge],
  ["bad", "comparison.status", "behind"],
  ["bad", "comparison.ahead_by", -1],
  ["unknown", "comparison.status", "unknown"],
];
for (const [name, path, replacement] of cases)
  test(`${name}:${path}:${JSON.stringify(replacement)}`, async () => {
    const input = JSON.parse(
      `{"locator":{"owner":"acme","repo":"forge","repositoryId":7,"branch":"feature/a","prNumber":9},"policy":{"project":"forge","repositoryId":7,"baseBranch":"feature/a","version":"1","digest":"${"d".repeat(64)}","producer":{"repositoryId":7,"appId":1,"workflowId":2,"workflowPath":".github/workflows/ci.yml","workflowDigest":"${"e".repeat(64)}"},"requiredChecks":["ci"]},"binding":{"project":"forge","issueId":"work-1","linkKey":"link:work-1:1","linkRevision":1,"repositoryId":7,"prNumber":9,"prId":"PR_node","headSha":"${head}"}}`,
    ) as Record<string, unknown>;
    const actual = name === "squash" ? merge : head,
      target = name === "identical" ? actual : tip;
    const first = JSON.parse(
      `{"number":9,"node_id":"PR_node","head":{"sha":"${head}"},"base":{"repo":{"id":7},"ref":"feature/a"},"state":"closed","merged":true,"merged_at":"${time}","merge_commit_sha":"${actual}"}`,
    ) as Record<string, unknown>;
    const fixture = {
      input,
      first,
      last: structuredClone(first),
      branch: JSON.parse(
        `{"ref":"refs/heads/feature/a","object":{"type":"commit","sha":"${target}"}}`,
      ) as unknown,
      comparison: JSON.parse(
        `{"base_commit":{"sha":"${actual}"},"merge_base_commit":{"sha":"${name === "behind" ? target : name === "diverged" ? "d".repeat(40) : actual}"},"status":"${["behind", "diverged", "identical"].includes(name) ? name : "ahead"}","ahead_by":${["identical", "behind"].includes(name) ? 0 : 1},"behind_by":${["behind", "diverged"].includes(name) ? 1 : 0}}`,
      ) as unknown,
    };
    if (path) {
      const parts = path.split(".");
      let at = fixture as Record<string, unknown>;
      for (const p of parts.slice(0, -1)) at = at[p] as Record<string, unknown>;
      at[parts.at(-1)!] = replacement;
    }
    let getters = 0,
      credentials = 0,
      extension = 0,
      snapshots = 0;
    if (name === "accessor")
      Object.defineProperty(input.policy, "version", {
        enumerable: true,
        get: () => {
          getters++;
          return "secret-sentinel";
        },
      });
    const before = name === "accessor" ? "" : JSON.stringify(fixture),
      calls: string[] = [];
    const ports = {
      signal: new AbortController().signal,
      now: () => (name === "clock" ? NaN : Date.parse(time) + 1000),
      deadline: (_expire: () => void, _ms: number) => () => {},
      credential(id: number) {
        credentials++;
        expect(id).toBe(7);
        return Promise.resolve({
          token: "secret-sentinel",
          expiresAt: Date.parse(time) + 20_000,
        });
      },
      fetch(url: string, init: RequestInit) {
        calls.push(url);
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("manual");
        expect(new Headers(init.headers).get("Authorization")).toBe(
          "Bearer secret-sentinel",
        );
        const endpoint = new URL(url).pathname;
        const value = endpoint.endsWith("/pulls/9")
          ? ++snapshots === 1
            ? first
            : fixture.last
          : endpoint.includes("/git/ref/")
            ? fixture.branch
            : fixture.comparison;
        return Promise.resolve(
          new Response(JSON.stringify(value), {
            status: name === "partial" && snapshots === 2 ? 503 : 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      },
    };
    const module = (await import(
      "../../cloud/src/" + "github-evidence.ts"
    ).catch(() => null)) as { withGithubPrEvidence?: Reader } | null;
    expect(typeof module?.withGithubPrEvidence).toBe("function");
    const result = await module!.withGithubPrEvidence!(
      input,
      ports,
      (s, pr) => {
        extension++;
        expect(snapshots).toBe(1);
        expect(pr.mergeSha).toBe(actual);
        expect(typeof s.collect).toBe("function");
        if (name === "extension") throw new Error("secret-sentinel raw-body");
        return Promise.resolve("workflow-seam");
      },
    );
    expect(getters).toBe(0);
    if (name !== "accessor") expect(JSON.stringify(fixture)).toBe(before);
    if (["ok", "squash", "identical", "behind", "diverged"].includes(name)) {
      const normalized = JSON.parse(
        `{"repositoryId":7,"number":9,"id":"PR_node","headSha":"${head}","state":"MERGED","mergeSha":"${actual}","mergedAt":"${time}","baseBranch":"feature/a"}`,
      ) as Facts["initialPr"];
      expect(result).toEqual({
        ok: true,
        value: {
          binding: input.binding as Facts["binding"],
          initialPr: normalized,
          finalPr: normalized,
          targetTip: target,
          ancestry: ["behind", "diverged"].includes(name)
            ? "not-ancestor"
            : "ancestor",
          evidence: "workflow-seam",
        },
      });
      expect(calls).toEqual([
        `https://api.github.com/repos/acme/forge/pulls/9`,
        `https://api.github.com/repos/acme/forge/git/ref/heads/feature%2Fa`,
        `https://api.github.com/repos/acme/forge/compare/${actual}...${target}`,
        `https://api.github.com/repos/acme/forge/pulls/9`,
      ]);
      expect(extension).toBe(1);
      expect(credentials).toBe(1);
      if (result.ok) expect(result.value.binding).not.toBe(input.binding);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(
          ["unknown", "partial", "extension"].includes(name)
            ? "UNAVAILABLE"
            : "INPUT_INVALID",
        );
        expect(Object.keys(result).sort()).toEqual(["code", "ok", "reason"]);
      }
      if (name === "branch-guard") expect(extension).toBe(0);
      if (["input", "accessor", "clock"].includes(name)) {
        expect(credentials).toBe(0);
        expect(calls).toEqual([]);
      }
      expect(JSON.stringify(result)).not.toMatch(/secret-sentinel|raw-body/);
    }
  });
