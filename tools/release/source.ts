import { appendFileSync } from "node:fs";

const shaPattern = /^[a-f0-9]{40}$/;

type SourceInput = { repo: string; sha: string; recovery: boolean };
type RunObject = Record<string, unknown>;
type SourceResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
export type SourceFetch = (
  url: string,
  init: { headers: { Authorization: string }; redirect: "manual" },
) => Promise<SourceResponse>;
export type SourceOutput = (text: string) => void;

class SourceFailure extends Error {}

function failure(message: string): never {
  throw new SourceFailure(message);
}

const object = (value: unknown): RunObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RunObject)
    : undefined;

function mismatch(field: string): never {
  failure(`release source: ${field} mismatch`);
}

export function assertRunId(runId: string): void {
  if (!/^[0-9]+$/.test(runId)) failure("release source: invalid run id");
}

export function sourceSha(run: unknown, input: SourceInput): string {
  const value = object(run);
  if (!value) failure("release source: run must be an object");
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
    failure("release source: head_sha invalid");
  if (!input.recovery && sha !== input.sha)
    failure("release source: head_sha differs from dispatch sha");
  return sha;
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) failure(`release source: missing ${name}`);
  return value;
};

export async function runSource(
  env: NodeJS.ProcessEnv,
  fetchRun: SourceFetch = fetch,
  writeOutput?: SourceOutput,
): Promise<number> {
  try {
    const runId = required(env, "RUN_ID");
    const readbackOnly = required(env, "READBACK_ONLY");
    const token = required(env, "GH_TOKEN");
    const api = required(env, "GITHUB_API_URL");
    const repo = required(env, "GITHUB_REPOSITORY");
    const sha = required(env, "GITHUB_SHA");
    const output = required(env, "GITHUB_OUTPUT");
    assertRunId(runId);
    let response: SourceResponse;
    try {
      response = await fetchRun(`${api}/repos/${repo}/actions/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
      });
    } catch {
      failure("release source: GitHub API request failed");
    }
    if (!response.ok)
      failure(`release source: GitHub API HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      failure("release source: unreadable JSON");
    }
    const source = sourceSha(body, {
      repo,
      sha,
      recovery: readbackOnly === "true",
    });
    try {
      if (writeOutput) writeOutput(`source_sha=${source}\n`);
      else appendFileSync(output, `source_sha=${source}\n`);
    } catch {
      failure("release source: output write failed");
    }
    return 0;
  } catch (error) {
    console.error(
      error instanceof SourceFailure ? error.message : "release source: failed",
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runSource(process.env);
