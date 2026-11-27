// [integration] The release policy consumes npm's verified bundles, never an advertised predicate alone.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { hash, X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { version } from "../../../src/version.ts";
import {
  assertRunId,
  runSource,
  sourceSha,
  type SourceFetch,
} from "../../../tools/release/source.ts";

const dir = mkdtempSync(join(tmpdir(), "forge-release-readback-"));
const repository = "https://github.com/harshanandak/forge";
const commit = "b".repeat(40);
const tarball = join(dir, "candidate.tgz");
const integrity = "sha512-" + hash("sha512", "reviewed archive", "base64");
let certificate = "";
let foreignCertificate = "";
beforeAll(() => {
  const args =
    "req -x509 -newkey rsa:2048 -nodes -days 1 -keyout key.pem -out cert.pem -subj /CN=fixture -addext".split(
      " ",
    );
  for (const repo of [repository, "https://github.com/foreign/repo"]) {
    const out = Bun.spawnSync(
      [
        "openssl",
        ...args,
        `subjectAltName=URI:${repo}/.github/workflows/release.yml@refs/heads/main`,
      ],
      { cwd: dir },
    );
    if (out.exitCode !== 0) throw new Error(out.stderr.toString());
    const made = new X509Certificate(
      readFileSync(join(dir, "cert.pem")),
    ).raw.toString("base64");
    if (repo === repository) certificate = made;
    else foreignCertificate = made;
  }
  writeFileSync(tarball, "reviewed archive");
  mkdirSync(join(dir, "bin"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const release = parse(
  readFileSync(
    new URL("../../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  ),
) as { jobs: Record<string, { steps: { run?: string; uses?: string }[] }> };

const repoName = "harshanandak/forge";
const validRun = () => ({
  repository: { full_name: repoName },
  head_repository: { full_name: repoName },
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: commit,
  status: "completed",
  conclusion: "success",
});
const cliEnv = (): NodeJS.ProcessEnv => ({
  RUN_ID: "12345",
  READBACK_ONLY: "false",
  GH_TOKEN: "token",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_REPOSITORY: repoName,
  GITHUB_SHA: commit,
  GITHUB_OUTPUT: "output.txt",
});
const quiet = async (run: () => Promise<number>) => {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    },
  );
  try {
    return { code: await run(), log: lines.join("\n") };
  } finally {
    spy.mockRestore();
  }
};

test("release source validation emits its original SHA in-process", () => {
  const repo = repoName;
  const ci = validRun();
  const source = (run: unknown, mode: string, sha = commit, id = "12345") => {
    assertRunId(id);
    return sourceSha(run, { repo, sha, recovery: mode === "true" });
  };
  const rejection = (check: () => unknown): string => {
    try {
      check();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected rejection");
  };
  const fieldErrors: Record<string, string> = {
    repository: "release source: repository.full_name mismatch",
    head_repository: "release source: head_repository.full_name mismatch",
    path: "release source: path mismatch",
    event: "release source: event mismatch",
    head_branch: "release source: head_branch mismatch",
    head_sha: "release source: head_sha invalid",
    status: "release source: status mismatch",
    conclusion: "release source: conclusion mismatch",
  };
  const older = "a".repeat(40);
  for (const mode of ["true", "false"]) {
    expect(source(ci, mode, mode === "true" ? older : commit)).toBe(commit);
    expect(rejection(() => source(ci, mode, commit, "invalid"))).toBe(
      "release source: invalid run id",
    );
    for (const field of Object.keys(ci))
      expect(rejection(() => source({ ...ci, [field]: "wrong" }, mode))).toBe(
        fieldErrors[field]!,
      );
  }
  expect(rejection(() => source(ci, "false", older))).toBe(
    "release source: head_sha differs from dispatch sha",
  );
}, 15_000);

test("release source CLI writes the exact output contract in-process", async () => {
  const writes: string[] = [];
  const calls: Parameters<SourceFetch>[] = [];
  const fetchRun: SourceFetch = (url, init) => {
    calls.push([url, init]);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(validRun()),
    });
  };
  const result = await quiet(() =>
    runSource(cliEnv(), fetchRun, (text) => writes.push(text)),
  );
  expect(result.code).toBe(0);
  expect(writes).toEqual([`source_sha=${commit}\n`]);
  expect(calls).toEqual([
    [
      "https://api.github.com/repos/harshanandak/forge/actions/runs/12345",
      { headers: { Authorization: "Bearer token" }, redirect: "manual" },
    ],
  ]);
}, 15_000);

test("release source CLI policy rejection writes nothing and exits nonzero", async () => {
  const writes: string[] = [];
  const fetchRun: SourceFetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ...validRun(), conclusion: "failure" }),
    });
  const result = await quiet(() =>
    runSource(cliEnv(), fetchRun, (text) => writes.push(text)),
  );
  expect({ code: result.code, writes, log: result.log }).toEqual({
    code: 1,
    writes: [],
    log: "release source: conclusion mismatch",
  });
}, 15_000);

test("release source CLI rejects non-2xx and redirect responses", async () => {
  for (const status of [500, 302]) {
    const writes: string[] = [];
    const fetchRun: SourceFetch = () =>
      Promise.resolve({
        ok: false,
        status,
        json: () => Promise.resolve(validRun()),
      });
    const result = await quiet(() =>
      runSource(cliEnv(), fetchRun, (text) => writes.push(text)),
    );
    expect({ code: result.code, writes, log: result.log }).toEqual({
      code: 1,
      writes: [],
      log: `release source: GitHub API HTTP ${status}`,
    });
  }
}, 15_000);

test("release source CLI never logs response text from unreadable JSON", async () => {
  const writes: string[] = [];
  const fetchRun: SourceFetch = () =>
    Promise.resolve(new Response("DEPLOYMENT_DETAIL", { status: 200 }));
  const result = await quiet(() =>
    runSource(cliEnv(), fetchRun, (text) => writes.push(text)),
  );
  expect(result.code).toBe(1);
  expect(writes).toEqual([]);
  expect(result.log).toBe("release source: unreadable JSON");
  expect(result.log).not.toContain("DEPLOYMENT_DETAIL");
}, 15_000);

test("release source CLI never logs fetch failure details", async () => {
  const writes: string[] = [];
  const fetchRun: SourceFetch = () =>
    Promise.reject(
      new Error("proxy saw DEPLOYMENT_DETAIL at https://api.github.com"),
    );
  const result = await quiet(() =>
    runSource(cliEnv(), fetchRun, (text) => writes.push(text)),
  );
  expect(result.code).toBe(1);
  expect(writes).toEqual([]);
  expect(result.log).toBe("release source: GitHub API request failed");
  expect(result.log).not.toContain("DEPLOYMENT_DETAIL");
  expect(result.log).not.toContain("https://api.github.com");
}, 15_000);

test("release workflow validates the source run with Bun after setup", () => {
  const steps = release.jobs.verify!.steps;
  const sourceIndex = steps.findIndex(
    (step) => step.run?.trim() === "bun tools/release/source.ts",
  );
  const setupIndex = steps.findIndex((step) =>
    step.uses?.startsWith(
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    ),
  );
  expect({
    run: steps[sourceIndex]?.run?.trim(),
    setupBeforeSource: setupIndex !== -1 && setupIndex < sourceIndex,
  }).toEqual({
    run: "bun tools/release/source.ts",
    setupBeforeSource: true,
  });
}, 15_000);

test("inline readback sends unique nonces and rejects unverifiable HTTP 200s", () => {
  const step = release.jobs.readback!.steps.find((s) =>
    s.run?.includes("registry source:"),
  )!;
  const script = step.run!.split("<<'JS'\n")[1]!.split("\nJS")[0]!;
  const transport = `
    import assert from 'node:assert/strict';
    import { hash as fixtureHash } from 'node:crypto';
    const seen = new Set();
    globalThis.fetch = async (url, options) => {
      const parsed = new URL(url);
      const nonce = parsed.searchParams.get('nocache');
      assert.ok(nonce && !seen.has(nonce), 'every registry request needs a unique nonce');
      seen.add(nonce);
      assert.equal(new Headers(options.headers).get('cache-control'), 'no-cache');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted);
      const headers = new Headers();
      if (cacheStatus !== '-') headers.set('CF-Cache-Status', cacheStatus);
      if (age !== '-') headers.set('Age', age);
      return Response.json(parsed.pathname.endsWith('/dist-tags') ? { next: process.env.VERSION } : {
        name: 'forge-workflow', version: process.env.VERSION,
        dist: { integrity: 'sha512-' + fixtureHash('sha512', 'reviewed archive', 'base64'),
                attestations: { provenance: { predicateType: 'fixture' } } },
      }, { headers });
    };
  `;
  for (const [cache, age, pass] of [
    ["DYNAMIC", "-", true],
    ["MISS", "0", true],
    ["BYPASS", "-", true],
    ["HIT", "-", false],
    ["STALE", "-", false],
    ["UPDATING", "-", false],
    ["DYNAMIC", "2", false],
    ["DYNAMIC", "bad", false],
    ["DYNAMIC", "", false],
    ["-", "-", false],
    ["OTHER", "-", false],
  ] as const) {
    const headers = JSON.stringify([cache, age]);
    const input = "const [cacheStatus, age] = " + headers + ";\n";
    const output = Bun.spawnSync([process.execPath, "run", "-"], {
      stdin: Buffer.from(input + transport + script),
      env: { ...process.env, VERSION: version, TARBALL: tarball },
      timeout: 2_000,
    });
    const stderr = output.stderr.toString();
    expect(output.exitCode === 0, stderr || headers).toBe(pass);
    if (!pass) expect(stderr).toMatch(/cached|unproven registry response/);
  }
}, 15_000);

function fixture() {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `pkg:npm/forge-workflow@${version}`,
        digest: { sha512: hash("sha512", "reviewed archive") },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository,
            path: ".github/workflows/release.yml",
            ref: "refs/heads/main",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+${repository}@refs/heads/main`,
            digest: { gitCommit: commit },
          },
        ],
      },
    },
  };
  const bundle = {
    predicateType: statement.predicateType,
    bundle: {
      dsseEnvelope: { payload: "" },
      verificationMaterial: {
        x509CertificateChain: { certificates: [{ rawBytes: certificate }] },
      },
    },
  };
  const audit = {
    invalid: [] as unknown[],
    missing: [] as unknown[],
    verified: [
      {
        name: "forge-workflow",
        version,
        registry: "https://registry.npmjs.org",
        attestationBundles: [bundle],
      },
    ],
  };
  const identity = { version, commit, dirty: false };
  const lock = {
    packages: {
      "node_modules/forge-workflow": {
        version,
        integrity,
        resolved: `https://registry.npmjs.org/forge-workflow/-/forge-workflow-${version}.tgz`,
      },
    },
  };
  const record = { ...identity, runId: "12345" };
  return { statement, bundle, audit, identity, lock, record };
}
type Fixture = ReturnType<typeof fixture>;
const workflow = (f: Fixture) =>
  f.statement.predicate.buildDefinition.externalParameters.workflow;
const rows: [string, (f: Fixture) => void, string?][] = [
  ["accepted reviewed identity and workflow", () => {}],
  ["accepted recovery of original CI commit", () => {}, commit],
  ["wrong expected commit", () => {}, "c".repeat(40)],
  ["empty expected commit", () => {}, ""],
  [
    "accepted certificate bundle",
    (f) => {
      const material = f.bundle.bundle.verificationMaterial;
      Object.assign(material, {
        certificate: material.x509CertificateChain.certificates[0],
      });
      Reflect.deleteProperty(material, "x509CertificateChain");
    },
  ],
  [
    "wrong installed version",
    (f) => Object.assign(f.identity, { version: "other" }),
  ],
  [
    "wrong installed commit",
    (f) => Object.assign(f.identity, { commit: "c".repeat(40) }),
  ],
  ["dirty build", (f) => Object.assign(f.identity, { dirty: true })],
  [
    "local archive",
    (f) => {
      f.lock.packages["node_modules/forge-workflow"].resolved =
        "file:candidate.tgz";
    },
  ],
  [
    "record wrong commit",
    (f) => {
      f.record.commit = "c".repeat(40);
    },
  ],
  [
    "record wrong version",
    (f) => {
      f.record.version = "other";
    },
  ],
  [
    "record wrong run",
    (f) => {
      f.record.runId = "54321";
    },
  ],
  [
    "record missing",
    (f) => {
      Reflect.deleteProperty(f, "record");
    },
  ],
  [
    "substituted installed archive",
    (f) =>
      Object.assign(f.lock.packages["node_modules/forge-workflow"], {
        integrity: "sha512-other",
      }),
  ],
  ["missing provenance", (f) => Object.assign(f.audit, { verified: [] })],
  [
    "foreign package",
    (f) => Object.assign(f.audit.verified[0]!, { name: "other" }),
  ],
  [
    "foreign version",
    (f) => Object.assign(f.audit.verified[0]!, { version: "other" }),
  ],
  [
    "invalid signature",
    (f) => f.audit.invalid.push({ code: "EINTEGRITYSIGNATURE" }),
  ],
  [
    "missing signature",
    (f) => f.audit.missing.push({ name: "forge-workflow" }),
  ],
  [
    "foreign predicate",
    (f) => Object.assign(f.statement, { predicateType: "foreign" }),
  ],
  [
    "foreign repository",
    (f) =>
      Object.assign(workflow(f), {
        repository: "https://github.com/foreign/repo",
      }),
  ],
  [
    "foreign workflow",
    (f) => Object.assign(workflow(f), { path: ".github/workflows/other.yml" }),
  ],
  [
    "foreign ref",
    (f) => Object.assign(workflow(f), { ref: "refs/heads/other" }),
  ],
  [
    "foreign source commit",
    (f) => {
      f.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit =
        "c".repeat(40);
    },
  ],
  [
    "substituted attested archive",
    (f) => {
      f.statement.subject[0]!.digest.sha512 = "c".repeat(128);
    },
  ],
  [
    "foreign subject",
    (f) =>
      Object.assign(f.statement.subject[0]!, { name: "pkg:npm/other@1.0.0" }),
  ],
  [
    "foreign signer with matching payload",
    (f) => {
      f.bundle.bundle.verificationMaterial.x509CertificateChain.certificates[0]!.rawBytes =
        foreignCertificate;
    },
  ],
  [
    "missing signing certificate",
    (f) => {
      f.bundle.bundle.verificationMaterial.x509CertificateChain.certificates =
        [];
    },
  ],
];
for (const [name, change, expectedCommit] of rows)
  test(`release readback: ${name}`, () => {
    const marker = join(dir, "executed");
    rmSync(marker, { force: true });
    const f = fixture();
    change(f);
    const recordPath = join(dir, "build.json");
    rmSync(recordPath, { force: true });
    if (f.record) writeFileSync(recordPath, JSON.stringify(f.record));
    f.bundle.bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(f.statement),
    ).toString("base64");
    const paths = [f.identity, f.audit, f.lock].map((value, index) => {
      const path = join(
        dir,
        index === 0 ? "bin/identity.mjs" : `${index}.json`,
      );
      writeFileSync(
        path,
        index === 0
          ? `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'ran'); process.stdout.write(${JSON.stringify(JSON.stringify(value))});`
          : JSON.stringify(value),
      );
      return path;
    });
    const bun = Bun.which("bun");
    if (!bun) throw new Error("Bun required for release policy tests");
    const out = Bun.spawnSync(
      [
        bun,
        resolve(import.meta.dirname, "../../../tools/release/readback.mjs"),
        ...paths,
      ],
      {
        env: {
          ...process.env,
          VERSION: version,
          GITHUB_SHA: name.startsWith("accepted recovery")
            ? "c".repeat(40)
            : commit,
          EXPECTED_COMMIT: expectedCommit,
          CI_RUN: "12345",
          TARBALL: tarball,
        },
        timeout: 10_000,
      },
    );
    expect(out.exitCode === 0, out.stderr.toString()).toBe(
      name.startsWith("accepted"),
    );
    expect(existsSync(marker)).toBe(
      name.startsWith("accepted") ||
        name.startsWith("wrong installed") ||
        name === "dirty build",
    );
    if (name.startsWith("accepted"))
      expect(out.stdout.toString()).toContain('"runId":"12345"');
    if (
      name.startsWith("record ") ||
      name === "substituted installed archive" ||
      name === "local archive"
    ) {
      const source = readFileSync(
        resolve(import.meta.dirname, "../../../tools/release/readback.mjs"),
        "utf8",
      );
      const removed = name.startsWith("record ")
        ? source.replace(
            /assert\.deepEqual\(\s*read\(resolve\(dirname\(bin\), "\.\.\/build\.json"\)\),[\s\S]*?\);/,
            "",
          )
        : name === "local archive"
          ? source.replace(
              /assert\.equal\(\s*installed\.resolved,[\s\S]*?\);/,
              "",
            )
          : source.replace("assert.equal(installed.integrity, integrity);", "");
      expect(removed).not.toBe(source);
      const mutant = join(dir, "guard-removed.mjs");
      writeFileSync(mutant, removed);
      const unguarded = Bun.spawnSync([bun, mutant, ...paths], {
        env: {
          ...process.env,
          VERSION: version,
          GITHUB_SHA: commit,
          CI_RUN: "12345",
          TARBALL: tarball,
        },
        timeout: 10_000,
      });
      expect(unguarded.exitCode, unguarded.stderr.toString()).toBe(0);
      expect(existsSync(marker)).toBe(true);
    }
  }, 15_000);
