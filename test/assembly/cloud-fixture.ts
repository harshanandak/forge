// Shared fixtures for the cloud login tests: a project checkout, a home folder, a fixture clock and a
// scripted network. Nothing here reaches a real network.
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { createProcessPort } from "../../src/adapters/process/index.ts";
import { spawnSync } from "node:child_process";
import type { CloudFetch } from "../../src/adapters/http/index.ts";
import type {
  CredentialEntry,
  CloudBinding,
} from "../../src/assembly/cloud-profile.ts";

export type ScopedGitApi = Pick<
  typeof import("../../src/assembly/providers.ts"),
  "gitCapability" | "resolveOutside"
>;

/** A saved lexical project outside the lane's canonical ancestry, with real executable markers. */
export function persistedRootsFixture() {
  const dir = mkdtempSync(join(import.meta.dirname, ".forge-saved-roots-"));
  const project = join(dir, "project"),
    outside = mkdtempSync(join(tmpdir(), "forge-saved-lane-"));
  const trusted = realpathSync.native(Bun.which("git")!);
  const git = (args: string[]) => {
    const result = spawnSync(trusted, args, {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  mkdirSync(project);

  git(["init", "-q", "-b", "main", project]);
  git([
    "-C",
    project,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
    "--allow-empty",
  ]);
  const target = join(outside, "lane");
  git(["-C", project, "worktree", "add", "-q", "-b", "feat/one", target]);
  const alias = join(project, ".worktrees");
  symlinkSync(
    outside,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const lexical = join(alias, "lane");
  const bin = join(project, "bin"),
    marker = join(bin, "launched");
  mkdirSync(bin);
  writeFileSync(
    join(bin, process.platform === "win32" ? "git.cmd" : "git"),
    process.platform === "win32"
      ? '@echo off\r\necho launched>"%~dp0launched"\r\nexit /b 99\r\n'
      : '#!/bin/sh\nprintf launched > "${0%/*}/launched"\nexit 99\n',
    { mode: 0o755 },
  );
  const pair = (lexical: string) => ({
    lexical,
    real: realpathSync.native(lexical),
  });
  const scope = { project: pair(project), lane: pair(lexical) };
  const snapshot = () =>
    [
      join(project, ".git", "HEAD"),
      join(project, ".git", "refs", "heads", "feat", "one"),
      join(target, ".git"),
    ].map((path) => readFileSync(path).toString("hex"));
  return {
    project,
    target,
    lexical,
    alias,
    scope,
    marker,
    snapshot,
    env: {
      PATH: [bin, trusted.replace(/[\\/][^\\/]*$/, "")].join(delimiter),
      PATHEXT: process.platform === "win32" ? ".CMD;.EXE" : "",
      SystemRoot: process.env.SystemRoot ?? "",
    },
    close: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  };
}
export async function launchSavedGit(
  fixture: ReturnType<typeof persistedRootsFixture>,
  saved: import("../../src/assembly/providers.ts").GitScope | null,
  api: Pick<
    typeof import("../../src/assembly/providers.ts"),
    "reopenGitScope" | "gitCapability"
  >,
  root = fixture.target,
) {
  const scope = api.reopenGitScope(root, saved);
  const port = createProcessPort({
    supervision: {
      cleanupTimeoutMs: 1000,
      pollIntervalMs: 25,
      drainTimeoutMs: 100,
      maxConcurrent: 1,
    },
  });
  const executable = api.gitCapability(port, fixture.env, scope).executable();
  if (executable.kind !== "resolved") throw new Error(executable.reason);
  return port.run(executable, ["--version"], {
    cwd: root,
    env: fixture.env,
    timeoutMs: 10000,
    maxOutputBytes: 16384,
  });
}

export const gitScopeRows = [
  "unrelated repository",
  "plain checkout",
  "relative and empty",
  "only unsafe",
  "no git",
  "project alias",
  "install alias",
  "cross-project",
  "cross-project alias",
] as const;
export type GitScopeRow = (typeof gitScopeRows)[number];
/** Synthetic state and marker executables only; never opens the device's tracker or credentials. */
export async function exerciseGitScope(
  row: GitScopeRow,
  api: ScopedGitApi,
  selectionOnly = false,
) {
  const dir = mkdtempSync(join(import.meta.dirname, ".forge-git-scope-"));
  const project = join(dir, "project"),
    external = join(dir, "unrelated-install"),
    relativeInstall = join(dir, "relative-install");
  const marker = (root: string) => join(root, "launched");
  const pair = (lexical: string) => ({
    lexical,
    real: realpathSync.native(lexical),
  });
  try {
    for (const root of [project, external, relativeInstall]) {
      mkdirSync(root);
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, process.platform === "win32" ? "git.cmd" : "git"),
        process.platform === "win32"
          ? '@echo off\r\necho launched>"%~dp0launched"\r\necho fixture\r\n'
          : '#!/bin/sh\nprintf launched > "${0%/*}/launched"\nprintf fixture\n',
        { mode: 0o755 },
      );
    }
    if (row === "no git" && process.platform === "win32")
      copyFileSync(process.execPath, join(project, "..exe"));
    const scope = { project: pair(project), lane: pair(project) };
    const alias = join(
      row === "project alias"
        ? project
        : row === "cross-project alias"
          ? relativeInstall
          : dir,
      "alias",
    );
    if (["project alias", "install alias", "cross-project alias"].includes(row))
      symlinkSync(
        row === "install alias" ? project : external,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
    const paths =
      row === "no git"
        ? []
        : row === "project alias" ||
            row === "install alias" ||
            row === "cross-project alias"
          ? [alias]
          : row === "only unsafe"
            ? [project]
            : row === "relative and empty"
              ? [relative(process.cwd(), relativeInstall), "", ".", external]
              : [project, external];
    const env = {
      PATH: paths.join(delimiter),
      PATHEXT: ".CMD",
      SystemRoot: process.env.SystemRoot ?? "",
    };
    const port = createProcessPort({
      supervision: {
        cleanupTimeoutMs: 1000,
        pollIntervalMs: 25,
        drainTimeoutMs: 100,
        maxConcurrent: 1,
      },
    });
    const pin = api.gitCapability(port, env, scope);
    if (row === "plain checkout") env.PATH = "";
    const target =
      row === "cross-project"
        ? { project: pair(external), lane: pair(external) }
        : row === "cross-project alias"
          ? { project: pair(relativeInstall), lane: pair(relativeInstall) }
          : scope;
    if (
      row === "cross-project alias" &&
      api.gitCapability(port, env, target).executable().kind !== "unavailable"
    )
      throw new Error("Direct project-B alias selection must be refused");
    // Selection and pin revalidation independently reject relative paths.
    const executable = selectionOnly
      ? api.resolveOutside(port, "git", env, project)
      : pin.executable(target);
    let launched = false;
    if (executable.kind === "resolved") {
      const result = await port.run(executable, [], {
        cwd: project,
        env,
        timeoutMs: 5000,
        maxOutputBytes: 1024,
      });
      if (result.exitCode !== 0 || result.timedOut || result.truncated)
        throw new Error(`Fixture launch failed: ${result.stderr}`);
      launched = true;
    }
    return {
      kind: executable.kind,
      launched,
      projectRan: existsSync(marker(project)),
      externalRan: existsSync(marker(external)),
      relativeRan: existsSync(marker(relativeInstall)),
      diagnostic:
        executable.kind === "unavailable" &&
        executable.reason.includes(
          row === "no git"
            ? "absolute PATH"
            : row === "cross-project"
              ? external
              : paths[0]!,
        ),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function withoutGuard<T>(
  url: URL,
  guard: string | RegExp,
  replacement = "",
) {
  const source =
    readFileSync(url, "utf8") + "\nexport const mutationLoaded=true;";
  const changed = source.replace(guard, replacement);
  if (changed === source) throw new Error(`Mutation was not applied: ${guard}`);
  const absolute = changed.replace(
    /from "(\.[^"]+)"/g,
    (_all, path: string) => `from "${new URL(path, url).href}"`,
  );
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(absolute);
  return (await import(
    `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
  )) as T & { mutationLoaded: boolean };
}

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const ORIGIN = "https://forge.example.test";
export const OTHER_ORIGIN = "https://other.example.test";
export const PROJECT = "proj";
export const DEVICE_CODE = "d".repeat(42) + "C";
export const USER_CODE = "BCDF-GHJK";
export const SECRET = "S".repeat(43);
export const DAY = 86_400_000;

export interface Sandbox {
  readonly dir: string;
  readonly root: string;
  readonly home: string;
  readonly deviceRoot: string;
  readonly credentials: string;
  readonly binding: string;
  close(): void;
}
/** A checkout (with a project identity unless told otherwise), a home folder and a device folder. */
export function sandbox(options: { manifest?: boolean } = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "forge-cloud-login-"));
  const root = join(dir, "project");
  const home = join(dir, "home");
  const deviceRoot = join(dir, "device");
  mkdirSync(join(root, ".forge"), { recursive: true });
  mkdirSync(home);
  if (options.manifest !== false)
    writeFileSync(
      join(root, ".forge", "project.json"),
      `${JSON.stringify({ schema: 1, id: PROJECT_ID })}\n`,
    );
  return {
    dir,
    root,
    home,
    deviceRoot,
    credentials: join(home, ".forge", "cloud", "credentials.json"),
    binding: join(root, ".forge", "cloud.json"),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function clock(start = Date.UTC(2026, 10, 11)) {
  let time = start;
  const waits: number[] = [];
  return {
    now: () => time,
    waits,
    advance(ms: number) {
      time += ms;
    },
    wait(ms: number, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      waits.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
}

export function tokenFor(id = "0123456789abcdef", secret = SECRET): string {
  return `fct_${id}.${secret}`;
}
/** The JSON string the Worker returns as `credential`, with expiry relative to the fixture clock. */
export function credentialJson(
  now: number,
  change: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    format: "forge/device-credential/1",
    id: "0123456789abcdef",
    token: tokenFor(),
    device: "dev-1",
    expiresAt: new Date(now + 30 * DAY).toISOString(),
    ...change,
  });
}
export function entry(
  now: number,
  change: Partial<CredentialEntry> = {},
): CredentialEntry {
  return {
    origin: ORIGIN,
    identity: PROJECT_ID,
    project: PROJECT,
    localDevice: "dev-1",
    id: "aaaaaaaaaaaaaaaa",
    token: tokenFor("aaaaaaaaaaaaaaaa", "O".repeat(43)),
    device: "dev-1",
    expiresAt: new Date(now + 30 * DAY).toISOString(),
    ...change,
  };
}
export function bindingFor(change: Partial<CloudBinding> = {}): CloudBinding {
  return {
    schema: 1,
    identity: PROJECT_ID,
    origin: ORIGIN,
    project: PROJECT,
    ...change,
  };
}

export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
export const startBody = (change: Record<string, unknown> = {}) => ({
  ok: true,
  device_code: DEVICE_CODE,
  user_code: USER_CODE,
  expires_in: 600,
  interval: 5,
  verification_uri: "/device",
  project: PROJECT,
  device: "dev-1",
  ...change,
});
export const pending = () =>
  json({ ok: false, error: "authorization_pending" }, 400);
export const refusal = (error: string, interval?: number, status = 400) =>
  json(
    { ok: false, error, ...(interval === undefined ? {} : { interval }) },
    status,
  );
export const approved = (credential: string) => json({ ok: true, credential });

export interface Call {
  readonly url: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly init: Parameters<CloudFetch>[1];
}
export type Step = (call: Call) => Response | Promise<Response>;
/** Answers the nth request with the nth step (the last step repeats) and records every request. */
export function network(...steps: Step[]) {
  const calls: Call[] = [];
  const fetch: CloudFetch = (url, init) => {
    let body: unknown;
    try {
      body = JSON.parse(init.body ?? "");
    } catch {
      body = init.body;
    }
    const call = { url, body, headers: init.headers, init };
    calls.push(call);
    const step = steps[Math.min(calls.length, steps.length) - 1];
    if (step === undefined) return Promise.reject(new Error("no step"));
    try {
      return Promise.resolve(step(call));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("step"));
    }
  };
  return { calls, fetch };
}
