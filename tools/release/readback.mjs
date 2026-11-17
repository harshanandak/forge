import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { hash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const [bin, auditFile, lockFile] = process.argv.slice(2);
const {
  VERSION: version,
  GITHUB_SHA: commit,
  TARBALL: tarball,
  CI_RUN: runId,
} = process.env;
assert.match(commit ?? "", /^[a-f0-9]{40}$/);
const digest = hash("sha512", readFileSync(tarball));
const integrity = "sha512-" + Buffer.from(digest, "hex").toString("base64");
const installed = read(lockFile).packages["node_modules/forge-workflow"];
assert.equal(installed.version, version);
assert.equal(installed.integrity, integrity);
assert.equal(
  installed.resolved,
  `https://registry.npmjs.org/forge-workflow/-/forge-workflow-${version}.tgz`,
);
const audit = read(auditFile);
assert.deepEqual(audit.invalid, []);
assert.deepEqual(audit.missing, []);
// npm supplies these bundles only after cryptographic signature/attestation verification.
const verified = audit.verified.filter((p) => p.name === "forge-workflow");
assert.equal(verified.length, 1);
assert.equal(verified[0].version, version);
assert.equal(new URL(verified[0].registry).href, "https://registry.npmjs.org/");
const type = "https://slsa.dev/provenance/v1";
const attestations = verified[0].attestationBundles;
const bundles = attestations.filter((b) => b.predicateType === type);
assert.equal(bundles.length, 1);
const { bundle } = bundles[0];
const payload = bundle.dsseEnvelope.payload;
const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
assert.equal(statement._type, "https://in-toto.io/Statement/v1");
assert.equal(statement.predicateType, type);
const purl = `pkg:npm/forge-workflow@${encodeURIComponent(version)}`;
const subject = { name: purl, digest: { sha512: digest } };
assert.deepEqual(statement.subject, [subject]);
const repo = "https://github.com/harshanandak/forge";
const path = ".github/workflows/release.yml",
  ref = "refs/heads/main";
const definition = statement.predicate.buildDefinition;
assert.deepEqual(definition.externalParameters.workflow, {
  repository: repo,
  path,
  ref,
});
const source = { uri: `git+${repo}@${ref}`, digest: { gitCommit: commit } };
assert.deepEqual(definition.resolvedDependencies, [source]);
const { certificate, x509CertificateChain } = bundle.verificationMaterial;
const der = (certificate ?? x509CertificateChain.certificates[0]).rawBytes;
const signer = new X509Certificate(Buffer.from(der, "base64")).subjectAltName;
assert.equal(signer, `URI:${repo}/${path}@${ref}`);
assert.deepEqual(
  read(resolve(dirname(bin), "../build.json")),
  { version, commit, dirty: false, runId },
  "installed build identity record must match the reviewed CI run",
);
// Check the approved bytes and signer before executing the installed package.
const args = [bin, "--version", "--json"];
const options = { timeout: 30_000, windowsHide: true };
const identity = JSON.parse(execFileSync(process.execPath, args, options));
assert.deepEqual(identity, { version, commit, dirty: false });
console.log(
  JSON.stringify({
    ...identity,
    runId,
    integrity,
    node: process.version,
    bin: resolve(bin),
  }),
);
