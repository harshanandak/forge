// [integration] The release policy consumes npm's verified bundles, never an advertised predicate alone.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { hash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "forge-release-readback-"));
const repository = "https://github.com/harshanandak/forge";
const version = "0.1.0-beta.9",
  commit = "b".repeat(40);
const tarball = join(dir, "candidate.tgz");
const integrity = "sha512-" + hash("sha512", "reviewed archive", "base64");
let certificate = "";
beforeAll(() => {
  const out = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      "key.pem",
      "-out",
      "cert.pem",
      "-subj",
      "/CN=fixture",
      "-addext",
      `subjectAltName=URI:${repository}/.github/workflows/release.yml@refs/heads/main`,
    ],
    { cwd: dir },
  );
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  certificate = new X509Certificate(
    readFileSync(join(dir, "cert.pem")),
  ).raw.toString("base64");
  writeFileSync(tarball, "reviewed archive");
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
        registry: "https://registry.npmjs.org/",
        attestationBundles: [bundle],
      },
    ],
  };
  const identity = { version, commit, dirty: false };
  const lock = {
    packages: { "node_modules/forge-workflow": { version, integrity } },
  };
  return { statement, bundle, audit, identity, lock };
}
type Fixture = ReturnType<typeof fixture>;
const rows: [string, (f: Fixture) => void][] = [
  ["accepted reviewed identity and workflow", () => {}],
  [
    "wrong installed version",
    (f) => {
      f.identity.version = "other";
    },
  ],
  [
    "wrong installed commit",
    (f) => {
      f.identity.commit = "c".repeat(40);
    },
  ],
  [
    "dirty build",
    (f) => {
      f.identity.dirty = true;
    },
  ],
  [
    "substituted installed archive",
    (f) => {
      f.lock.packages["node_modules/forge-workflow"].integrity = "sha512-other";
    },
  ],
  [
    "missing provenance",
    (f) => {
      f.audit.verified = [];
    },
  ],
  [
    "foreign package",
    (f) => {
      f.audit.verified[0]!.name = "other";
    },
  ],
  [
    "foreign version",
    (f) => {
      f.audit.verified[0]!.version = "other";
    },
  ],
  [
    "invalid signature",
    (f) => {
      f.audit.invalid.push({ code: "EINTEGRITYSIGNATURE" });
    },
  ],
  [
    "missing signature",
    (f) => {
      f.audit.missing.push({ name: "forge-workflow" });
    },
  ],
  [
    "foreign predicate",
    (f) => {
      f.statement.predicateType = "https://foreign.example/provenance";
    },
  ],
  [
    "foreign repository",
    (f) => {
      f.statement.predicate.buildDefinition.externalParameters.workflow.repository =
        "https://github.com/foreign/repo";
    },
  ],
  [
    "foreign workflow",
    (f) => {
      f.statement.predicate.buildDefinition.externalParameters.workflow.path =
        ".github/workflows/other.yml";
    },
  ],
  [
    "foreign ref",
    (f) => {
      f.statement.predicate.buildDefinition.externalParameters.workflow.ref =
        "refs/heads/other";
    },
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
    (f) => {
      f.statement.subject[0]!.name = "pkg:npm/other@1.0.0";
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
    const f = fixture();
    change(f);
    f.bundle.bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(f.statement),
    ).toString("base64");
    const paths = [f.identity, f.audit, f.lock].map((value, index) => {
      const path = join(dir, `${index}.json`);
      writeFileSync(path, JSON.stringify(value));
      return path;
    });
    const bun = Bun.which("bun");
    if (!bun) throw new Error("Bun required for release policy tests");
    const out = Bun.spawnSync(
      [
        bun,
        resolve(import.meta.dirname, "../../../tools/release/readback.ts"),
        ...paths,
      ],
      {
        env: {
          ...process.env,
          VERSION: version,
          GITHUB_SHA: commit,
          TARBALL: tarball,
        },
        timeout: 10_000,
      },
    );
    expect(out.exitCode === 0, out.stderr.toString()).toBe(
      name.startsWith("accepted"),
    );
  }, 15_000);
