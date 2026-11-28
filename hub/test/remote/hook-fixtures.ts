import { test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeHostBridge } from "../fakes/fake-host.ts";
import { fakeCore, key, person, safeOutput } from "./fixtures.ts";

type Hook = "pre-tool" | "session-start" | "stop";
export const hubRoot = fileURLToPath(new URL("../../", import.meta.url));
export const hubCommand = [
  "--import",
  new URL("./database-diagnostics.mjs", import.meta.url).href,
  join(hubRoot, "bin", "forge-hub.mjs"),
];
export const session = { session_id: "s1", source: "startup" };
export const stop = { session_id: "s1", stop_hook_active: false };
export const r1 =
  "Forge reply-only mode: this session read a message from someone other than its owner. Reply through forge-hub, or ask your owner to approve the work.\n";
export const r2 = "Forge hub: pass sessionId ses_a for this session.\n";
export const r3 = (code: string) =>
  `Forge hub could not confirm this session (${code}). Read tools inside the working directory still work.\n`;
export const guard = (
  cwd: string,
  tool_name = "Write",
  tool_input: unknown = {},
) => ({ session_id: "s1", tool_name, tool_input, cwd });
export const silence = { status: 0, stdout: "", stderr: "" };
export const deny = (stderr: string) => ({ ...silence, status: 2, stderr });

export async function child(
  cwd: string,
  args: string[],
  input = "",
  extra: Record<string, string> = {},
) {
  const node = Bun.which("node");
  if (!node) throw new Error("Selected Node is unavailable");
  const env = { TEMP: cwd, TMP: cwd, TMPDIR: cwd, ...extra };
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SystemDrive",
    "WINDIR",
    "ComSpec",
  ]) {
    const value = process.env[name];
    if (value !== undefined) Object.assign(env, { [name]: value });
  }
  const proc = Bun.spawn([node, ...args], {
    cwd,
    env,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    windowsHide: true,
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  safeOutput(stdout + stderr);
  return { status, stdout, stderr };
}

export const answer = (result: unknown) =>
  Response.json({ ok: true, status: "OK", result });
export const mode = (value = "normal", sessionId = "ses_a") =>
  answer(
    value === "unregistered" ? { mode: value } : { mode: value, sessionId },
  );
export const failure = (status: number, code: string) =>
  Response.json({ ok: false, status: "FAIL", error: { code } }, { status });
export const hung = (signal: AbortSignal) =>
  new Promise<Response>((resolve) => {
    signal.addEventListener(
      "abort",
      () => resolve(new Response(null, { status: 408 })),
      { once: true },
    );
  });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-hook-"));
  const keyPath = join(root, "host");
  await writeFile(keyPath, key + "\n", { mode: 0o600 });
  const seen: Array<{
    path: string;
    method: string;
    bearer: string | null;
    type: string | null;
    body: unknown;
  }> = [];
  const bridge = new FakeHostBridge(fakeCore(), {
    person,
    hostInstanceId: "hst_a",
  });
  const f = {
    respond: (
      path: string,
      _signal: AbortSignal,
    ): Response | Promise<Response> =>
      answer(
        path.endsWith("/session")
          ? bridge.start("s1")
          : path.endsWith("/stop")
            ? { result: "posted" }
            : bridge.mode("s1"),
      ),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const { method, headers, signal } = req;
      seen.push({
        path,
        method,
        bearer: headers.get("authorization"),
        type: headers.get("content-type"),
        body: await req.json(),
      });
      return f.respond(path, signal);
    },
  });
  const url = server.url.origin;
  const run = (hook: Hook, input: unknown, env = {}, flags: string[] = []) => {
    const script = join(hubRoot, "bin", hook + ".mjs");
    return child(
      root,
      [...flags, script],
      typeof input === "string" ? input : JSON.stringify(input),
      {
        FORGE_HUB_URL: url,
        FORGE_HUB_HOST_KEY_FILE: keyPath,
        ...env,
      },
    );
  };
  return Object.assign(f, {
    root,
    url,
    keyPath,
    seen,
    run,
    tool: (name?: string, input?: unknown, env?: Record<string, string>) =>
      run("pre-tool", guard(root, name, input), env),
    files: async () => (await readdir(root)).sort(),
    path: (name: string) => join(root, name),
    stopServer: () => server.stop(true),
    async close() {
      await server.stop(true);
      await rm(root, { force: true, recursive: true });
    },
  });
}

export const hookTest =
  (timeout: number) =>
  (
    name: string,
    run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  ) =>
    test(
      name,
      async () => {
        const f = await fixture();
        try {
          await run(f);
        } finally {
          await f.close();
        }
      },
      timeout,
    );
