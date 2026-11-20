// Shared by the built-CLI and installed-package journeys: a cloud-bound project, a stored credential, and
// a real HTTPS server on loopback that plays the cloud's command route. The child process trusts the
// server's throwaway certificate through Node's own NODE_EXTRA_CA_CERTS; no production module has a switch.
import { expect } from "bun:test";
import { createServer, type Server } from "node:https";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  readdirSync,
  readFileSync,
  statSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LocalState } from "../../../src/assembly/state.ts";
import { boundLaneKey } from "../../../src/blocks/work/bound-lane-state.ts";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import {
  credentialStore,
  openCloudFiles,
  type CredentialEntry,
} from "../../../src/assembly/cloud-profile.ts";
import type { ResultEnvelope } from "../../../src/generated/types.ts";
import * as fx from "../cloud-fixture.ts";

export const TOKEN = fx.entry(0).token;
const CANARIES = [TOKEN, "O".repeat(43)];
const NOW = "2026-11-11T00:00:00.000Z";
export const ISSUE = {
  id: "forge-1",
  title: "Issue 1",
  status: "open",
  labels: ["a"],
  dependsOn: [],
  createdAt: NOW,
  updatedAt: NOW,
  revision: 3,
};
export const PAGE = { items: [ISSUE], truncated: false };
export const LANE = {
  issue: "work-1",
  issueId: "work-1",
  worktree: "/lane",
  branch: "feat/one",
  brief: "brief.md",
};
export const GRANT = {
  subject: "issue:work-1",
  holder: {
    actor: { kind: "agent", id: "a1" },
    session: { id: "s1", device: "dev-1" },
  },
  generation: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

export interface ReadCase {
  readonly args: string[];
  readonly op: string;
  readonly input: object;
  readonly result: object;
}
export const SHOW: ReadCase = {
  args: ["issue", "show", ISSUE.id],
  op: "issue.show",
  input: { id: ISSUE.id },
  result: ISSUE,
};
export const READS: readonly ReadCase[] = [
  SHOW,
  { args: ["issue", "list"], op: "issue.list", input: {}, result: PAGE },
  {
    args: ["issue", "list", "--status", "open"],
    op: "issue.list",
    input: { status: "open" },
    result: PAGE,
  },
  { args: ["issue", "ready"], op: "issue.ready", input: {}, result: PAGE },
];

export interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}
export interface Reply {
  readonly status: number;
  readonly body: unknown;
}
type Replier = (seen: Seen) => Reply | Promise<Reply>;
const results: Record<string, object> = {
  "issue.show": ISSUE,
  "issue.list": PAGE,
  "issue.ready": PAGE,
};
const serve: Replier = ({ body }) => {
  const op = (body as { op?: string } | undefined)?.op ?? "";
  const result = results[op];
  return result === undefined
    ? refuse("UNKNOWN_COMMAND", 404)
    : {
        status: 200,
        body: { ok: true, op, status: "OK", result, warnings: [] },
      };
};
/** A refusal whose text carries the token, to prove nothing the server says reaches an output. */
export const refuse = (
  code: string,
  status: number,
  message = TOKEN,
): Reply => ({
  status,
  body: {
    ok: false,
    status: "FAIL",
    error: { code, message },
    warnings: [],
  },
});

const processes = createProcessPort({
  supervision: {
    cleanupTimeoutMs: 5000,
    pollIntervalMs: 25,
    drainTimeoutMs: 250,
    maxConcurrent: 1,
  },
});
async function program(
  name: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const found = processes.resolve(name, env);
  if (found.kind !== "resolved")
    throw new Error(
      `${name} could not be run: ${found.reason}. ${found.remedy}`,
    );
  return processes.run(found, args, {
    cwd,
    env,
    timeoutMs: 40_000,
    maxOutputBytes: 1_000_000,
  });
}

/** One self-signed certificate for 127.0.0.1, valid for a day, made by openssl into the sandbox. */
async function certificate(dir: string, env: Record<string, string>) {
  mkdirSync(dir);
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const made = await program(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    dir,
    env,
  );
  if (made.exitCode !== 0)
    throw new Error(
      `openssl could not make the test certificate: ${made.stderr}`,
    );
  return { key: readFileSync(key), cert: readFileSync(cert), file: cert };
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());

export interface CloudRig {
  readonly root: string;
  readonly origin: string;
  readonly env: Record<string, string>;
  readonly requests: Seen[];
  run(
    args: string[],
    overrides?: Record<string, string>,
  ): Promise<{
    envelope: ResultEnvelope;
    status: number | null;
    stdout: string;
    stderr: string;
  }>;
  mcp(
    name: string,
    input: object,
  ): Promise<{ envelope: ResultEnvelope; stdout: string; stderr: string }>;
  /** The project holds only what the test put there, and no token is anywhere outside the credential store. */
  expectUntouched(out: { stdout: string; stderr: string }): void;
  profile(): (string | null)[];
  close(): Promise<void>;
}

/** A bound project whose cloud is a loopback HTTPS server; `bin` is the forge.js the journey runs. */
export async function cloudRig(
  bin: string,
  reply: Replier = serve,
  setup: "bound" | "attached" | "guarded" | "unbound" = "bound",
  identity?: { device: string; session: string },
): Promise<CloudRig> {
  const s = fx.sandbox();
  const attachment = setup === "attached";
  const canaries = [...CANARIES];
  let server: Server | undefined;
  try {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(
        (pair): pair is [string, string] => pair[1] !== undefined,
      ),
    );
    const tls = await certificate(join(s.dir, "tls"), base);
    const requests: Seen[] = [];
    const listening = createServer(
      { key: tls.key, cert: tls.cert },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = undefined;
          }
          const seen = {
            method: req.method,
            url: req.url,
            authorization: req.headers.authorization,
            body,
          };
          requests.push(seen);
          void Promise.resolve(reply(seen))
            .then((answer) => {
              if (seen.url?.endsWith("/loginpoll")) {
                const { credential } = answer.body as { credential?: string };
                if (credential !== undefined)
                  canaries.push(
                    (JSON.parse(credential) as CredentialEntry).token,
                  );
              }
              res.writeHead(answer.status, {
                "content-type": "application/json",
              });
              res.end(JSON.stringify(answer.body));
            })
            .catch((error: Error) => res.destroy(error));
        });
      },
    );
    server = listening;
    await new Promise<void>((resolve) =>
      listening.listen(0, "127.0.0.1", resolve),
    );
    const address = listening.address();
    if (address === null || typeof address === "string")
      throw new Error("the loopback server has no port");
    const origin = `https://127.0.0.1:${address.port}`;
    const root = realpathSync(s.root);

    writeFileSync(
      join(s.root, ".forge", "config.yaml"),
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: {
          work: {
            source: { builtin: "forge/work" },
            config: { idPrefix: "forge" },
          },
          ...(identity === undefined
            ? {}
            : { cloud: { source: { builtin: "forge/cloud" } } }),
        },
        mcp: { expose: ["lane", "issue"] },
      }),
    );
    if (identity === undefined && setup !== "unbound") {
      writeFileSync(
        s.binding,
        `${JSON.stringify(fx.bindingFor({ origin }))}\n`,
      );
      await credentialStore(openCloudFiles(s.home)).save(
        fx.entry(Date.now(), { origin }),
      );
    }
    const preload: string[] = [];
    const marker = join(s.dir, "project-owner-opened");
    if (attachment) {
      const state = new LocalState(join(s.deviceRoot, "records.sqlite"));
      try {
        (await state.open(true))!.put(
          "forge/work",
          boundLaneKey(fx.bindingFor({ origin }), "work-1"),
          {
            version: 1,
            id: "work-1",
            cloudId: ISSUE.id,
            lane: LANE,
            grant: GRANT,
            active: true,
          },
          { kind: "agent", id: "a1" },
          { expectRevision: 0 },
        );
      } finally {
        await state.close();
      }
    }
    if (setup === "attached" || setup === "guarded") {
      const guard = join(s.dir, "owner-sentinel.mjs");
      const module = pathToFileURL(
        resolve(dirname(bin), "../src/assembly/state.js"),
      ).href;
      writeFileSync(
        guard,
        `import {LocalState} from ${JSON.stringify(module)}; import {writeFileSync} from 'node:fs'; LocalState.prototype.acquire=function(){writeFileSync(${JSON.stringify(marker)},'opened');throw new Error('local project owner acquired');};`,
      );
      preload.push("--import", pathToFileURL(guard).href);
    }
    const deviceBytes = () =>
      filesUnder(s.deviceRoot)
        .sort()
        .map((path) => [path, readFileSync(path).toString("hex")]);
    const beforeDevice = attachment ? deviceBytes() : [];
    const env = {
      ...base,
      HOME: s.home,
      USERPROFILE: s.home,
      FORGE_DEVICE_ROOT: s.deviceRoot,
      FORGE_DEVICE_ID: identity?.device ?? "dev-1",
      FORGE_SESSION: identity?.session ?? "cloud-dist-test",
      FORGE_NO_BROWSER: "1",
      NODE_EXTRA_CA_CERTS: tls.file,
    };
    const stop = () =>
      new Promise<void>((resolve) => listening.close(() => resolve()));
    return {
      root,
      origin,
      env,
      requests,
      async run(args, overrides) {
        // Native asynchronous children permit a real three-session arrival race.
        const out = await promisify(execFile)(
          "node",
          [...preload, bin, ...args],
          {
            cwd: root,
            env: { ...env, ...overrides },
            timeout: 40_000,
            maxBuffer: 1_000_000,
            windowsHide: true,
          },
        ).then(
          (out) => ({ ...out, exitCode: 0 }),
          (error: {
            code?: unknown;
            killed?: boolean;
            stdout: string;
            stderr: string;
          }) => {
            if (error.killed || typeof error.code !== "number") throw error;
            return {
              stdout: error.stdout,
              stderr: error.stderr,
              exitCode: error.code,
            };
          },
        );
        const lines = out.stdout.trim().split("\n");
        expect(lines, out.stderr).toHaveLength(1);
        return {
          envelope: JSON.parse(lines[0] ?? "") as ResultEnvelope,
          status: out.exitCode,
          stdout: out.stdout,
          stderr: out.stderr,
        };
      },
      mcp: (name, input) =>
        mcpCall([...preload, bin, "--mcp"], s.root, env, name, input),
      expectUntouched(out) {
        expect(existsSync(marker)).toBe(false);
        if (attachment) expect(deviceBytes()).toEqual(beforeDevice);
        // The local store is .forge/state.sqlite, its journal files and its re-init folders: none may exist.
        expect(readdirSync(join(s.root, ".forge")).sort()).toEqual([
          "cloud.json",
          "config.yaml",
          "project.json",
        ]);
        for (const canary of canaries)
          expect(out.stdout + out.stderr).not.toContain(canary);
        const leaked = filesUnder(s.dir).filter(
          (path) =>
            path !== s.credentials &&
            canaries.some((canary) =>
              readFileSync(path, "utf8").includes(canary),
            ),
        );
        expect(leaked).toEqual([]);
      },
      profile: () =>
        [s.binding, s.credentials].map((path) =>
          existsSync(path)
            ? createHash("sha256").update(readFileSync(path)).digest("hex")
            : null,
        ),
      async close() {
        try {
          await stop();
        } finally {
          s.close();
        }
      },
    };
  } catch (error) {
    if (server?.listening) server.close();
    s.close();
    throw error;
  }
}

async function mcpCall(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  name: string,
  input: object,
) {
  const child = spawn("node", args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  const lines = createInterface({ input: child.stdout });
  let sequence = 0,
    stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  async function rpc(method: string, params: object) {
    const id = ++sequence;
    let receive!: (line: string) => void;
    let timer!: ReturnType<typeof setTimeout>;
    const answer = new Promise<unknown>((resolve, reject) => {
      receive = (line) => {
        const message = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: unknown;
        };
        if (message.id === id)
          message.error
            ? reject(new Error(JSON.stringify(message.error)))
            : resolve(message.result);
      };
      lines.on("line", receive);
      timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out: ${stderr}`)),
        20000,
      );
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
    try {
      return await answer;
    } finally {
      clearTimeout(timer);
      lines.off("line", receive);
    }
  }
  try {
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "cloud-packed", version: "1" },
    });
    child.stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    );
    const result = (await rpc("tools/call", { name, arguments: input })) as {
      content: { text: string }[];
      structuredContent: ResultEnvelope;
    };
    const stdout = result.content[0]!.text;
    expect(JSON.parse(stdout)).toEqual(result.structuredContent);
    return { envelope: result.structuredContent, stdout, stderr };
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      lines.close();
    }
  }
}

/** One cloud read through the CLI at `bin`: the cloud's result, exit 0, one authorised request, no local store. */
export async function proveRead(f: CloudRig, c: ReadCase): Promise<void> {
  const out = await f.run(c.args);
  expect(out.status, out.stderr).toBe(0);
  expect(out.envelope).toMatchObject({
    ok: true,
    op: c.op,
    status: "OK",
    result: c.result,
  });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({
    method: "POST",
    url: `/p/${fx.PROJECT}/command`,
    authorization: `Bearer ${TOKEN}`,
    body: { op: c.op, input: c.input },
  });
  f.expectUntouched(out);
}
