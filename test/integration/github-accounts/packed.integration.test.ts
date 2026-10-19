import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";

const root = resolve(import.meta.dirname, "../../..");
type Mutation = {
  from: string;
  to: string;
  mode: string;
  evidence: string;
  file?: string;
};
function run(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 120000,
  label = "child",
  maxStdoutBytes = 65536,
): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  error: Error | undefined;
}> {
  const started = performance.now();
  console.log(`Accounts packed ${label}: running`);
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env,
      windowsHide: true,
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const safeTail: string[] = [];
    let stdout = "",
      stderr = "",
      phase = "",
      lines = 0;
    let error: Error | undefined;
    let stdoutBytes = 0;
    const bounded = (value: string, limit = 65536): string =>
      Buffer.from(value).subarray(-limit).toString("utf8");
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      stdout = bounded(stdout + chunk, maxStdoutBytes);
      phase += chunk;
      while (phase.includes("\n")) {
        const end = phase.indexOf("\n");
        const line = phase.slice(0, end).trim();
        phase = phase.slice(end + 1);
        if (lines < 64 && /^Accounts [a-z -]{1,80}: [0-9]+ ms$/.test(line)) {
          console.log(`[${label}] ${line}`);
          safeTail.push(line);
          if (safeTail.length > 8) safeTail.shift();
          lines++;
        }
      }
      phase = phase.slice(-4096);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = bounded(stderr + chunk);
    });
    child.once("error", (cause) => {
      error = cause;
    });
    child.once("close", (status, signal) => {
      console.log(
        `Accounts packed ${label}: status=${String(status)} signal=${String(signal)} ${Math.round(performance.now() - started)} ms`,
      );
      if (status !== 0)
        console.log(
          `Accounts packed ${label} last safe phases:\n${safeTail.join("\n") || "No phase output"}`,
        );
      resolve({
        status,
        signal,
        stdout,
        stdoutTruncated: stdoutBytes > maxStdoutBytes,
        stderr,
        error,
      });
    });
  });
}
function withoutBun(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const key =
    Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  env[key] = (env[key] ?? "")
    .split(delimiter)
    .filter(
      (directory) =>
        !["bun", "bun.exe", "bunx", "bunx.exe"].some((name) =>
          existsSync(join(directory, name)),
        ),
    )
    .join(delimiter);
  delete env.BUN_INSTALL;
  return env;
}
test("packed accounts: parallel clone routing, Git identity guards, trailer policy, scoped writes and exact native restoration", async () => {
  const shared =
    process.env.ACCOUNTS_PACKED_CONSUMER ?? process.env.FORGE_PACKED_CONSUMER;
  const work = mkdtempSync(
    join(shared ?? tmpdir(), shared ? "ga-" : "forge-accounts-"),
  );
  const node = Bun.which("node");
  if (!node) throw Error("Node is required");
  const env = withoutBun();
  const successful = async (
    program: string,
    args: string[],
    cwd: string,
    childEnv = env,
    label = "setup",
    maxStdoutBytes = 65536,
    timeoutMs = 120000,
  ): Promise<string> => {
    const result = await run(
      program,
      args,
      cwd,
      childEnv,
      timeoutMs,
      label,
      maxStdoutBytes,
    );
    expect(
      result.status,
      `${result.error?.message ?? ""} ${result.stdout} ${result.stderr}`,
    ).toBe(0);
    if (maxStdoutBytes > 65536)
      expect(
        result.stdoutTruncated,
        `${label}: machine-readable stdout exceeds its declared byte budget`,
      ).toBe(false);
    return result.stdout;
  };
  try {
    const consumer = shared ? work : join(work, "consumer");
    if (!shared) mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      '{"private":true,"type":"module"}',
    );
    if (!shared) {
      await successful(
        process.execPath,
        ["run", "build"],
        root,
        process.env,
        "build",
      );
      const npm = [
        ...(process.env.FORGE_SMOKE_NPM_CLI
          ? [process.env.FORGE_SMOKE_NPM_CLI]
          : []),
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(existsSync);
      if (!npm) throw Error("npm CLI is required");
      const packed = JSON.parse(
        await successful(
          node,
          [
            npm,
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            work,
          ],
          root,
          env,
          "npm pack",
          1048576,
        ),
      ) as { filename: string }[];
      await successful(
        node,
        [
          npm,
          "install",
          join(work, packed[0]!.filename),
          "--no-audit",
          "--no-fund",
        ],
        consumer,
        env,
        "npm install",
      );
    }
    const fixtures = [
      "journey.mjs",
      "harness.mjs",
      "fake-gh.mjs",
      "counterfactual.mjs",
    ];
    for (const file of fixtures)
      copyFileSync(
        join(root, "test/node-fixtures/github-accounts", file),
        join(consumer, file),
      );
    const prepared = join(consumer, "prepared-clones.json");
    const positive = await successful(
      node,
      [join(consumer, "journey.mjs")],
      consumer,
      { ...env, FORGE_ACCOUNTS_PREPARED: prepared },
      "positive journeys",
      65536,
      180000,
    );
    expect(positive).toContain("PASS github-accounts all");
    const installed = join(shared ?? consumer, "node_modules/forge-workflow");
    const isolated = join(
      consumer,
      "node_modules/forge-accounts-counterfactual",
    );
    cpSync(installed, isolated, {
      recursive: true,
      filter: (file) => !file.endsWith(".map") && !file.endsWith(".ts"),
    });
    for (const file of fixtures)
      copyFileSync(join(consumer, file), join(isolated, file));
    copyFileSync(
      join(root, "test/integration/fixtures/mutation-proof.mjs"),
      join(isolated, "mutation-proof.mjs"),
    );
    const mutations: readonly Mutation[] = [
      {
        from: "user.login.toLowerCase() !== account.toLowerCase()",
        to: "false",
        mode: "auth-order",
        evidence: "failed login-mismatch preflight must refuse account binding",
      },
      {
        from: '!bound.emails.includes((author[0] ?? "").trim().toLowerCase())',
        to: "false",
        mode: "author",
        evidence: "wrong author email must be refused before push",
      },
      {
        from: '!bound.emails.includes((author[1] ?? "").trim().toLowerCase())',
        to: "false",
        mode: "committer",
        evidence: "wrong committer email must be refused before push",
      },
      {
        from: 'c.coauthorPolicy === "allow"',
        to: "true",
        mode: "trailers",
        evidence: "refuse policy must reject AI co-author trailers",
      },
      {
        file: "adapters/github-cli/scripts.js",
        from: '--user "$account"',
        to: "",
        mode: "route",
        evidence: "marked clone router",
      },
      {
        from: 'removeOverlays(original, overlays, ["binding", "hook"])',
        to: "original",
        mode: "restore",
        evidence:
          "unbind must restore every prior identity, helper and hook configuration value",
      },
      {
        file: "adapters/github-cli/scripts.js",
        from: "shell(options.envPath)",
        to: '"env"',
        mode: "environment",
        evidence:
          "configured environment launcher must stay pinned when PATH changes",
      },
    ];
    for (const mutation of selectShard(
      mutations,
      packedCoverage(process.env.STATE_NODE_LEG).shard,
    )) {
      const target = mutation.file ?? "blocks/github-accounts/entry.cjs";
      const file = join(isolated, "dist/src", target);
      const original = readFileSync(file, "utf8");
      expect(original, mutation.mode).toContain(mutation.from);
      try {
        const changed = original.replaceAll(mutation.from, mutation.to);
        writeFileSync(file, changed);
        const hash = createHash("sha256").update(changed).digest("hex");
        const proof = join(isolated, "capture-proof.jsonl");
        const moduleProof = join(isolated, "module-proof.jsonl");
        writeFileSync(proof, "");
        writeFileSync(moduleProof, "");
        const entryHash = createHash("sha256")
          .update(
            readFileSync(
              join(isolated, "dist/src/blocks/github-accounts/entry.cjs"),
            ),
          )
          .digest("hex");
        const childEnv = {
          ...env,
          FORGE_MUTATION_HASH: hash,
          FORGE_MUTATION_TARGET: file,
          FORGE_ACCOUNTS_CAPTURE_PROOF: proof,
          ...(mutation.file === undefined
            ? {}
            : {
                NODE_OPTIONS:
                  `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(isolated, "mutation-proof.mjs")).href}`.trim(),
                FORGE_MUTATION_PROOF: moduleProof,
              }),
        };
        const result = await run(
          node,
          [join(isolated, "counterfactual.mjs"), mutation.mode, prepared],
          consumer,
          childEnv,
          60000,
          `counterfactual ${mutation.mode}`,
        );
        const captured = readFileSync(proof, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                hash: string;
                entryHash: string;
                digest: string;
              },
          );
        expect(
          captured.some(
            (entry) =>
              entry.hash === hash &&
              entry.entryHash === entryHash &&
              /^sha256:[a-f0-9]{64}$/.test(entry.digest),
          ),
          "counterfactual must admit and execute the captured mutated bytes",
        ).toBe(true);
        if (mutation.file !== undefined) {
          const loaded = readFileSync(moduleProof, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) => JSON.parse(line) as { target: string; hash: string },
            );
          expect(
            loaded.some(
              (entry) =>
                entry.target === realpathSync(file) && entry.hash === hash,
            ),
            "adapter counterfactual must load the private mutated module bytes",
          ).toBe(true);
        }
        expect(
          readFileSync(join(installed, "dist/src", target), "utf8"),
          "the shared installation must remain unchanged",
        ).toBe(original);
        expect(result.status, mutation.mode).not.toBe(0);
        expect(
          result.stdout,
          "the private invocation and fixture rollback must complete before a counterfactual counts",
        ).toContain(`Accounts restored ${mutation.mode}:`);
        expect(`${result.stdout} ${result.stderr}`, mutation.mode).toContain(
          mutation.evidence,
        );
        console.log(
          `Accounts counterfactual ${mutation.mode}: captured mutated bytes, expected failure observed`,
        );
      } finally {
        writeFileSync(file, original);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 600000);
