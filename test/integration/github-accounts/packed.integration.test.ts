import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";

const root = resolve(import.meta.dirname, "../../..");
function run(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 300000,
) {
  return spawnSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout,
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
test("packed accounts: parallel clone routing, Git identity guards, trailer policy, scoped writes and exact native restoration", () => {
  const shared = process.env.FORGE_PACKED_CONSUMER;
  const work = mkdtempSync(
    join(shared ?? tmpdir(), shared ? "ga-" : "forge-accounts-"),
  );
  const node = Bun.which("node");
  if (!node) throw Error("Node is required");
  const env = withoutBun();
  const successful = (
    program: string,
    args: string[],
    cwd: string,
    childEnv = env,
  ): string => {
    const result = run(program, args, cwd, childEnv);
    expect(
      result.status,
      `${result.error?.message ?? ""} ${result.stdout} ${result.stderr}`,
    ).toBe(0);
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
      successful(process.execPath, ["run", "build"], root, process.env);
      const npm = [
        ...(process.env.FORGE_SMOKE_NPM_CLI
          ? [process.env.FORGE_SMOKE_NPM_CLI]
          : []),
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(existsSync);
      if (!npm) throw Error("npm CLI is required");
      const packed = JSON.parse(
        successful(
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
        ),
      ) as { filename: string }[];
      successful(
        node,
        [
          npm,
          "install",
          join(work, packed[0]!.filename),
          "--no-audit",
          "--no-fund",
        ],
        consumer,
      );
    }
    const fixtures = ["journey.mjs", "harness.mjs", "fake-gh.mjs"];
    for (const file of fixtures)
      copyFileSync(
        join(root, "test/node-fixtures/github-accounts", file),
        join(consumer, file),
      );
    const positive = successful(
      node,
      [join(consumer, "journey.mjs")],
      consumer,
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
    const mutations = [
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
        from: '--user "$account"',
        to: "",
        mode: "route",
        evidence: "marked clone router",
      },
      {
        from: "stageConfig(s, c, env, original, bound.previous)",
        to: "stageConfig(s, c, env, original, {})",
        mode: "restore",
        evidence:
          "unbind must restore every prior identity, helper and hook configuration value",
      },
    ];
    const file = join(isolated, "dist/src/blocks/github-accounts/entry.cjs");
    const original = readFileSync(file, "utf8");
    for (const mutation of selectShard(
      mutations,
      packedCoverage(process.env.STATE_NODE_LEG).shard,
    )) {
      expect(original, mutation.mode).toContain(mutation.from);
      try {
        const changed = original.replaceAll(mutation.from, mutation.to);
        writeFileSync(file, changed);
        const hash = createHash("sha256").update(changed).digest("hex");
        const proof = join(isolated, "capture-proof.jsonl");
        writeFileSync(proof, "");
        const result = run(
          node,
          [join(isolated, "journey.mjs"), mutation.mode],
          consumer,
          { ...env, FORGE_MUTATION_HASH: hash, FORGE_MUTATION_PROOF: proof },
        );
        const captured = readFileSync(proof, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { hash: string; digest: string });
        expect(
          captured.some(
            (entry) =>
              entry.hash === hash && /^sha256:[a-f0-9]{64}$/.test(entry.digest),
          ),
          "counterfactual must admit and execute the captured mutated bytes",
        ).toBe(true);
        expect(
          readFileSync(
            join(installed, "dist/src/blocks/github-accounts/entry.cjs"),
            "utf8",
          ),
          "the shared installation must remain unchanged",
        ).toBe(original);
        expect(result.status, mutation.mode).not.toBe(0);
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
