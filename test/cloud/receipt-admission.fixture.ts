import {
  ACTOR,
  call,
  maxSource,
  tablesOf,
} from "../../cloud/conformance/max-source.ts";
import type { EvidenceReceipt } from "../../cloud/src/evidence-receipts.ts";
import type { withGithubHttp } from "../../cloud/src/github-http.ts";
import type { WriteCall } from "../../cloud/src/issue-write.ts";
import { readMergePolicy } from "../../cloud/src/merge-policy.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import { fixture, at, head, merge } from "./merge-evidence.fixture.ts";

export type AdmissionPorts = Parameters<typeof withGithubHttp>[1] & {
  mergePolicy: () => ReturnType<typeof readMergePolicy>;
  repository: { host: "github.com"; owner: string; repo: string };
  verifierVersion: string;
};
export type Admission = (
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
  ports: AdmissionPorts,
) => Promise<EvidenceReceipt>;
export const namespace = "forge/work",
  subject = "issue:work-1";
export async function admissionFixture() {
  const source = await maxSource("forge", "work");
  const state = {
    auth: "",
    calls: [] as string[],
    credentials: 0,
    policyReads: 0,
    onRead: () => Promise.resolve(),
    onPolicy: () => Promise.resolve(),
    failCommit: false,
    prReads: 0,
    changedPr: false,
    unavailable: false,
    failingCheck: false,
  };
  const db: SqlDatabase = {
    exec: (sql) => {
      source.db.run(sql);
    },
    run: (sql, args = []) => {
      if (
        state.failCommit &&
        sql.startsWith("INSERT INTO domain_cloud_command_receipts")
      )
        throw new Error("injected command receipt failure");
      return source.db.query(sql).run(...(args as never[]));
    },
    get: (sql, args = []) =>
      (source.db.query(sql).get(...(args as never[])) ?? undefined) as
        SqlRow | undefined,
    all: (sql, args = []) =>
      source.db.query(sql).all(...(args as never[])) as SqlRow[],
    transaction: (body) => source.db.transaction(body)(),
  };
  const owner = new StateOwner(db, { now: () => Date.now() });
  const holder = {
    actor: ACTOR,
    session: { id: "admission", device: "laptop" },
  };
  const lease = owner.acquire(
    namespace,
    subject,
    holder,
    600_000,
    "admission-lease",
  );
  const link = (
    number = 1,
    url = "https://github.com/acme/forge/pull/490",
    relation = "delivers",
  ) => {
    const key = `link:work-1:${number}`,
      prior = owner.get(namespace, key);
    return owner.put(namespace, key, { id: "work-1", relation, url }, ACTOR, {
      expectRevision: prior?.revision ?? 0,
    });
  };
  link();
  const f = fixture();
  f.expected.issueId = "work-1";
  f.expected.linkKey = "link:work-1:1";
  f.policy.producer.workflowDigest =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  f.observation.runs[0]!.workflowDigest = f.policy.producer.workflowDigest;
  const { digest: _digest, ...policy } = f.policy;
  const env = {
    GITHUB_MERGE_POLICY: JSON.stringify(policy) as unknown,
    GITHUB_REPOSITORY_ID: "42",
    FORGE_CLOUD_PROJECT: "forge",
  };
  const write: WriteCall = {
    principal: ["token", "admission-fixture", "laptop"],
    requestId: "admission-request",
    input: { id: "work-1", pr: 490 },
    prefix: "work",
    device: "laptop",
    context: {
      variant: "leased",
      leaseMode: "held",
      actor: ACTOR,
      session: holder.session,
      project: { id: "forge" },
      leaseGeneration: lease.generation,
    },
    recheck: () => {
      if (state.auth)
        throw new ForgeFailure({
          code: state.auth,
          message: "Authentication changed",
          retry: "never",
        });
    },
    expiresAt: Date.now() + 3_600_000,
  };
  const ports: AdmissionPorts = {
    repository: { host: "github.com", owner: "acme", repo: "forge" },
    verifierVersion: "1",
    mergePolicy: async () => {
      const value = await readMergePolicy(env);
      if (++state.policyReads === 2) await state.onPolicy();
      return value;
    },
    now: () => Date.now(),
    signal: new AbortController().signal,
    deadline: () => () => {},
    credential: () => {
      state.credentials++;
      return Promise.resolve({
        token: "fixture-only",
        expiresAt: Date.now() + 60_000,
      });
    },
    fetch: async (url, init) => {
      state.calls.push(url);
      if (init.method !== "GET" || init.redirect !== "manual")
        throw new Error("Unsafe request");
      if (state.calls.length === 1) await state.onRead();
      if (state.unavailable) return new Response(null, { status: 503 });
      const path = new URL(url).pathname;
      const run = {
        id: 201,
        run_number: 10,
        run_attempt: 1,
        workflow_id: 99,
        path: ".github/workflows/ci.yml",
        repository: { id: 42 },
        head_sha: merge,
        check_suite_id: 401,
        status: "completed",
        conclusion: "success",
      };
      const outcome = {
        name: "CI Gate",
        status: "completed",
        conclusion: state.failingCheck ? "failure" : "success",
        completed_at: at,
      };
      let body: unknown;
      if (path.endsWith("/pulls/490")) {
        state.prReads++;
        body = {
          number: 490,
          node_id:
            state.changedPr && state.prReads === 2
              ? "PR_changed"
              : "PR_example",
          head: { sha: head },
          base: { repo: { id: 42 }, ref: "main" },
          state: "closed",
          merged: true,
          merged_at: at,
          merge_commit_sha: merge,
        };
      } else if (path.includes("/git/ref/"))
        body = {
          ref: "refs/heads/main",
          object: { type: "commit", sha: merge },
        };
      else if (path.includes("/compare/"))
        body = {
          base_commit: { sha: merge },
          merge_base_commit: { sha: merge },
          status: "identical",
          ahead_by: 0,
          behind_by: 0,
        };
      else if (path.includes("/contents/"))
        body = {
          type: "file",
          path: run.path,
          encoding: "base64",
          content: "YWJj",
          size: 3,
        };
      else if (path.endsWith("/check-suites/401"))
        body = {
          id: 401,
          head_sha: merge,
          repository: { id: 42 },
          app: { id: 15368 },
        };
      else if (path.endsWith("/check-runs/301"))
        body = {
          ...outcome,
          id: 301,
          head_sha: merge,
          app: { id: 15368 },
          check_suite: { id: 401 },
        };
      else if (path.endsWith("/jobs"))
        body = {
          total_count: 1,
          jobs: [
            {
              ...outcome,
              id: 501,
              run_id: 201,
              run_attempt: 1,
              head_sha: merge,
              check_run_url:
                "https://api.github.com/repos/acme/forge/check-runs/301",
            },
          ],
        };
      else if (path.endsWith("/actions/runs"))
        body = { total_count: 1, workflow_runs: [run] };
      else if (path.endsWith("/attempts/1")) body = run;
      else throw new Error(`Unexpected fixture endpoint: ${path}`);
      return Response.json(body);
    },
  };
  const snapshot = () => ({
    tables: tablesOf(source.db),
    evidence: db.all(
      "SELECT * FROM domain_cloud_evidence_receipts ORDER BY id",
    ),
  });
  return {
    ...source,
    dbSource: source.db,
    db,
    owner,
    holder,
    lease,
    write,
    ports,
    state,
    env,
    f,
    link,
    snapshot,
    routeCall: call,
  };
}
export type AdmissionFixture = Awaited<ReturnType<typeof admissionFixture>>;
