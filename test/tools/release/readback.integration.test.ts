// [integration] The release policy consumes npm's verified bundles, never an advertised predicate alone.
import { afterAll, beforeAll, expect, test } from "bun:test";
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

const dir = mkdtempSync(join(tmpdir(), "forge-release-readback-"));
const repository = "https://github.com/harshanandak/forge";
const version = "0.1.0-beta.9",
  commit = "b".repeat(40);
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
const rows: [string, (f: Fixture) => void][] = [
  ["accepted reviewed identity and workflow", () => {}],
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
for (const [name, change] of rows)
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
          GITHUB_SHA: commit,
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
