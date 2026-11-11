// Shared by the built-CLI and installed-package journeys: a cloud-bound project, a stored credential, and
// a real HTTPS server on loopback that plays the cloud's command route. The child process trusts the
// server's throwaway certificate through Node's own NODE_EXTRA_CA_CERTS; no production module has a switch.
import { expect } from "bun:test";
import { createServer, type Server } from "node:https";
import {
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import {
  credentialStore,
  openCloudFiles,
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
type Replier = (seen: Seen) => Reply;
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
  readonly env: Record<string, string>;
  readonly requests: Seen[];
  run(args: string[]): Promise<{
    envelope: ResultEnvelope;
    status: number | null;
    stdout: string;
    stderr: string;
  }>;
  /** The project holds only what the test put there, and no token is anywhere outside the credential store. */
  expectUntouched(out: { stdout: string; stderr: string }): void;
  close(): Promise<void>;
}

/** A bound project whose cloud is a loopback HTTPS server; `bin` is the forge.js the journey runs. */
export async function cloudRig(
  bin: string,
  reply: Replier = serve,
): Promise<CloudRig> {
  const s = fx.sandbox();
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
          const answer = reply(seen);
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(JSON.stringify(answer.body));
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

    writeFileSync(
      join(s.root, ".forge", "config.yaml"),
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: { work: { source: { builtin: "forge/work" } } },
      }),
    );
    writeFileSync(s.binding, `${JSON.stringify(fx.bindingFor({ origin }))}\n`);
    await credentialStore(openCloudFiles(s.home)).save(
      fx.entry(Date.now(), { origin }),
    );
    const env = {
      ...base,
      HOME: s.home,
      USERPROFILE: s.home,
      FORGE_DEVICE_ROOT: s.deviceRoot,
      FORGE_DEVICE_ID: "dev-1",
      FORGE_SESSION: "cloud-dist-test",
      NODE_EXTRA_CA_CERTS: tls.file,
    };
    const stop = () =>
      new Promise<void>((resolve) => listening.close(() => resolve()));
    return {
      env,
      requests,
      async run(args) {
        const out = await program("node", [bin, ...args], s.root, env);
        expect(out.timedOut).toBe(false);
        const lines = out.stdout.trim().split("\n");
        expect(lines, out.stderr).toHaveLength(1);
        return {
          envelope: JSON.parse(lines[0] ?? "") as ResultEnvelope,
          status: out.exitCode,
          stdout: out.stdout,
          stderr: out.stderr,
        };
      },
      expectUntouched(out) {
        // The local store is .forge/state.sqlite, its journal files and its re-init folders: none may exist.
        expect(readdirSync(join(s.root, ".forge")).sort()).toEqual([
          "cloud.json",
          "config.yaml",
          "project.json",
        ]);
        for (const canary of CANARIES)
          expect(out.stdout + out.stderr).not.toContain(canary);
        const leaked = filesUnder(s.dir).filter(
          (path) =>
            path !== s.credentials &&
            CANARIES.some((canary) =>
              readFileSync(path, "utf8").includes(canary),
            ),
        );
        expect(leaked).toEqual([]);
      },
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
