import { expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeHostBridge } from "../fakes/fake-host.ts";
import { digest, FakeHubCore, key, person } from "./fixtures.ts";

export type Hook = "pre-tool" | "session-start" | "stop";
export const hubRoot = fileURLToPath(new URL("../../", import.meta.url));
export const session = { session_id: "s1", source: "startup" };
export const stop = { session_id: "s1", stop_hook_active: false };
export const r1 =
  "Forge reply-only mode: this session read a message from someone other than its owner. Reply through forge-hub, or ask your owner to approve the work.\n";
export const r2 = "Forge hub: pass sessionId ses_a for this session.\n";
export const r3 = (code: string) =>
  "Forge hub could not confirm this session (" +
  code +
  "). Read tools inside the working directory still work.\n";
export const guard = (
  cwd: string,
  tool_name = "Write",
  tool_input: unknown = {},
) => ({ session_id: "s1", tool_name, tool_input, cwd });

export function child(
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
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const proc = spawn(node, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: "pipe",
        timeout: 15_000,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      proc.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      proc.stdin.on("error", (error) => {
        if (!("code" in error) || error.code !== "EPIPE") reject(error);
      });
      proc.once("error", reject);
      proc.once("close", (status) => resolve({ status, stdout, stderr }));
      proc.stdin.end(input);
    },
  );
}

export async function hookFixture() {
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
  const bridge = new FakeHostBridge(new FakeHubCore(), {
    person,
    hostInstanceId: "hst_a",
  });
  const fixture = {
    root,
    keyPath,
    seen,
    respond: (
      path: string,
      _signal: AbortSignal,
    ): Response | Promise<Response> => {
      const result = path.endsWith("/session")
        ? bridge.start("s1")
        : path.endsWith("/stop")
          ? { result: "posted" }
          : bridge.mode("s1");
      return Response.json({ ok: true, status: "OK", result });
    },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push({
        path,
        method: request.method,
        bearer: request.headers.get("authorization"),
        type: request.headers.get("content-type"),
        body: await request.json(),
      });
      return fixture.respond(path, request.signal);
    },
  });
  const url = server.url.origin;
  return Object.assign(fixture, {
    url,
    stopServer: () => server.stop(true),
    async run(
      hook: Hook,
      input: unknown,
      env: Record<string, string> = {},
      flags: string[] = [],
    ) {
      const result = await child(
        root,
        [...flags, join(hubRoot, "dist", "hooks", hook + ".js")],
        typeof input === "string" ? input : JSON.stringify(input),
        {
          FORGE_HUB_URL: url,
          FORGE_HUB_HOST_KEY_FILE: keyPath,
          ...env,
        },
      );
      for (const stream of [result.stdout, result.stderr]) {
        expect(stream).not.toContain(key);
        expect(stream).not.toContain(digest(key));
      }
      return result;
    },
    async close() {
      await server.stop(true);
      await rm(root, { force: true, recursive: true });
    },
  });
}

export const mode = (value: string = "normal", sessionId = "ses_a") =>
  Response.json({
    ok: true,
    status: "OK",
    result:
      value === "unregistered" ? { mode: value } : { mode: value, sessionId },
  });
export const failure = (status: number, code: string) =>
  Response.json({ ok: false, status: "FAIL", error: { code } }, { status });
export const silence = { status: 0, stdout: "", stderr: "" };
export const hung = (signal: AbortSignal) =>
  new Promise<Response>((resolve) => {
    signal.addEventListener(
      "abort",
      () => resolve(new Response(null, { status: 408 })),
      { once: true },
    );
  });
