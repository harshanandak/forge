import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import type {
  ProcessPort,
  ProcessResult,
  SpawnOptions,
} from "../../../src/ports/process.ts";

export type Json = Record<string, unknown>;
export type Call = {
  input: Json;
  config?: unknown;
  services?: unknown;
  signal: AbortSignal;
  deadline: number;
};
export type Handler = (call: Call) => unknown;
export function load(
  name: "pr" | "github",
  mutation?: { from: string; to: string },
): Record<string, Handler> {
  let source = readFileSync(
    resolve(import.meta.dirname, `../../../src/blocks/${name}/entry.cts`),
    "utf8",
  );
  if (mutation) {
    if (!source.includes(mutation.from))
      throw new Error("Missing counterfactual anchor");
    source = source.replace(mutation.from, mutation.to);
  }
  const module = { exports: {} as Record<string, Handler> };
  runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source), {
    module,
    exports: module.exports,
    fail(code: string, message: string) {
      throw Object.assign(new Error(message), { code });
    },
  });
  return module.exports;
}
export function processFake(
  reply: (args: readonly string[], options: SpawnOptions) => unknown,
): ProcessPort & { readonly cwd: string } {
  return {
    capability: "forge.process/v1",
    cwd: "/clone",
    resolve: (path) => ({ kind: "resolved", path }),
    async run(_executable, args, options): Promise<ProcessResult> {
      const response = await reply(args, options);
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(response),
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 1,
      };
    },
  };
}
export const head = "a".repeat(40),
  base = "b".repeat(40);
export const reference = { repository: "owner/repository", number: 42 };
export function ready(): Json {
  return {
    ...reference,
    headSha: head,
    baseSha: base,
    state: "OPEN",
    draft: false,
    mergeable: "MERGEABLE",
    complete: true,
    checks: [
      {
        name: "tests",
        appId: 7,
        headSha: head,
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ],
    requiredChecks: [{ name: "tests", appId: 7 }],
    reviews: [
      {
        id: "R1",
        author: "reviewer",
        state: "APPROVED",
        headSha: head,
        updatedAt: 1000,
      },
    ],
    threads: [],
    findings: [],
    lastActivityAt: 1000,
  };
}
export const prConfig = {
  envNames: [],
  provider: {
    executable: "provider",
    readArgs: ["read"],
    writeArgs: ["call"],
    timeoutMs: 5000,
    maxOutputBytes: 65536,
  },
  minApprovals: 1,
  settleMs: 100,
  optionalChecks: "safe-terminal",
  allowNoChecks: false,
  blockingLabels: ["P0", "P1"],
  leaseMs: 1000,
  squashTitle: "Merge {repository} #{number}",
  squashBody: "",
};
export function call(input: Json, config: unknown, services: unknown): Call {
  return {
    input,
    config,
    services,
    signal: new AbortController().signal,
    deadline: Date.now() + 10000,
  };
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}
