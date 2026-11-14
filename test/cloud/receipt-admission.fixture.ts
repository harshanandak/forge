import {
  ACTOR,
  maxSource,
  tablesOf,
} from "../../cloud/conformance/max-source.ts";
import type { WriteCall } from "../../cloud/src/issue-write.ts";
import { runCommand } from "../../cloud/src/issue-commands.ts";
import {
  mergePolicyBinding,
  readMergePolicy,
} from "../../cloud/src/merge-policy.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import { fixture, at, head, merge } from "./merge-evidence.fixture.ts";

type AdmissionPorts = Parameters<
  typeof import("../../cloud/src/receipt-admission.ts").admitReceipt
>[3];
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
    prState: "merged",
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
    mergePolicyBinding: () => mergePolicyBinding(env),
    mergePolicy: async () => {
      const pending = readMergePolicy(env);
      if (++state.policyReads === 2) await state.onPolicy();
      return pending;
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
    fetch: async (url) => {
      state.calls.push(url);
      if (state.calls.length === 1) await state.onRead();
      if (state.unavailable) return new Response(null, { status: 503 });
      const path = new URL(url).pathname;
      if (path.endsWith("/pulls/490")) state.prReads++;
      const conclusion = state.failingCheck ? "failure" : "success";
      const run = `{"id":201,"run_number":10,"run_attempt":1,"workflow_id":99,"path":".github/workflows/ci.yml","repository":{"id":42},"head_sha":"${merge}","check_suite_id":401,"status":"completed","conclusion":"success"}`;
      const outcome = `"head_sha":"${merge}","name":"CI Gate","status":"completed","conclusion":"${conclusion}","completed_at":"${at}"`;
      const responses: [string, string][] = [
        [
          "pulls/490",
          JSON.stringify({
            number: 490,
            node_id:
              state.changedPr && state.prReads === 2
                ? "PR_changed"
                : "PR_example",
            head: { sha: head },
            base: { repo: { id: 42 }, ref: "main" },
            state: state.prState === "open" ? "open" : "closed",
            merged: state.prState === "merged",
            merged_at: state.prState === "merged" ? at : null,
            merge_commit_sha: state.prState === "merged" ? merge : null,
          }),
        ],
        [
          "git/ref/heads/main",
          `{"ref":"refs/heads/main","object":{"type":"commit","sha":"${merge}"}}`,
        ],
        [
          `compare/${merge}...${merge}`,
          `{"base_commit":{"sha":"${merge}"},"merge_base_commit":{"sha":"${merge}"},"status":"identical","ahead_by":0,"behind_by":0}`,
        ],
        [
          "contents/.github/workflows/ci.yml",
          '{"type":"file","path":".github/workflows/ci.yml","encoding":"base64","content":"YWJj","size":3}',
        ],
        [
          "check-suites/401",
          `{"id":401,"head_sha":"${merge}","repository":{"id":42},"app":{"id":15368}}`,
        ],
        [
          "check-runs/301",
          `{${outcome},"id":301,"app":{"id":15368},"check_suite":{"id":401}}`,
        ],
        [
          "jobs",
          `{"total_count":1,"jobs":[{${outcome},"id":501,"run_id":201,"run_attempt":1,"check_run_url":"https://api.github.com/repos/acme/forge/check-runs/301"}]}`,
        ],
        ["actions/runs", `{"total_count":1,"workflow_runs":[${run}]}`],
        ["attempts/1", run],
      ];
      const response = responses.find(([suffix]) =>
        path.endsWith(`/${suffix}`),
      );
      if (!response) throw new Error(`Unexpected fixture endpoint: ${path}`);
      return new Response(response[1], {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  const snapshot = () => ({
    tables: tablesOf(source.db),
    evidence: db.all(
      "SELECT key, body FROM state_records WHERE namespace=? AND key=?",
      [namespace, "evidence:work-1"],
    ),
  });
  const legacyEvidence = () =>
    db.all("SELECT * FROM domain_cloud_evidence_receipts ORDER BY id");
  const command = (input: unknown = write.input, op = "issue.close") => {
    if (
      write.context.variant !== "leased" ||
      write.context.leaseMode !== "held"
    )
      throw new Error("Expected held fixture context");
    const { actor, session, project, leaseGeneration } = write.context;
    const host = {
      device: write.device,
      project: "forge",
      session: "admission",
      principal: write.principal,
      storage: {
        sql: {
          exec: (sql: string, ...args: unknown[]) => ({
            toArray: () => [...db.all(sql, args as never[])],
          }),
        },
        transactionSync: <T>(body: () => T) => db.transaction(body),
        get: () => Promise.resolve(undefined),
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(false),
      },
      idPrefix: write.prefix,
      now: ports.now(),
      recheck: write.recheck,
      expiresAt: write.expiresAt,
      open: () => ({ db, owner }),
      github: ports,
    };
    return Promise.resolve().then(() =>
      runCommand(
        JSON.stringify({
          requestId: write.requestId,
          op,
          input,
          context: { actor, session, project, leaseGeneration },
        }),
        host,
      ),
    );
  };
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
    command,
    legacyEvidence,
  };
}
export type AdmissionFixture = Awaited<ReturnType<typeof admissionFixture>>;
