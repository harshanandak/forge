import { appendFileSync } from "node:fs";

const shaPattern = /^[a-f0-9]{40}$/;

type SourceInput = { repo: string; sha: string; recovery: boolean };
type RunObject = Record<string, unknown>;

const object = (value: unknown): RunObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RunObject)
    : undefined;

const mismatch = (field: string): never => {
  throw new Error(`release source: ${field} mismatch`);
};

export function assertRunId(runId: string): void {
  if (!/^[0-9]+$/.test(runId))
    throw new Error("release source: invalid run id");
}

export function sourceSha(run: unknown, input: SourceInput): string {
  const value = object(run);
  if (!value) throw new Error("release source: run must be an object");
  if (object(value.repository)?.full_name !== input.repo)
    mismatch("repository.full_name");
  if (object(value.head_repository)?.full_name !== input.repo)
    mismatch("head_repository.full_name");
  const expected = {
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  } as const;
  for (const [field, wanted] of Object.entries(expected))
    if (value[field] !== wanted) mismatch(field);
  const sha = value.head_sha;
  if (typeof sha !== "string" || !shaPattern.test(sha))
    throw new Error("release source: head_sha invalid");
  if (!input.recovery && sha !== input.sha)
    throw new Error("release source: head_sha differs from dispatch sha");
  return sha;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`release source: missing ${name}`);
  return value;
};

if (import.meta.main) {
  try {
    const env = process.env;
    const runId = required(env, "RUN_ID");
    const readbackOnly = required(env, "READBACK_ONLY");
    const token = required(env, "GH_TOKEN");
    const api = required(env, "GITHUB_API_URL");
    const repo = required(env, "GITHUB_REPOSITORY");
    const sha = required(env, "GITHUB_SHA");
    const output = required(env, "GITHUB_OUTPUT");
    assertRunId(runId);
    const response = await fetch(`${api}/repos/${repo}/actions/runs/${runId}`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    if (!response.ok)
      throw new Error(`release source: GitHub API HTTP ${response.status}`);
    const source = sourceSha(await response.json(), {
      repo,
      sha,
      recovery: readbackOnly === "true",
    });
    appendFileSync(output, `source_sha=${source}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
