import { expect, test } from "bun:test";
import { posix } from "node:path";
import { findIdentityMintViolations } from "./lib/identity.ts";
import {
  CODE_FILE,
  format,
  listRepoFiles,
  readJson,
  readRepoFiles,
} from "./lib/repo.ts";

const fixtures = readJson(
  "test/structure/fixtures/identity-mint-imports.json",
) as Record<string, string>;
const mint = "src/ports/identity-mint.ts";
const paths = listRepoFiles();

test("only the exact OAuth validation boundary may carry verifier-minted identity", () => {
  for (const path of [
    "cloud/src/adapters/workers-oauth/index.ts",
    "cloud/src/adapters/workers-oauth/other.ts",
    "cloud/src/adapters/workers-oauth/index.test.ts",
    "cloud/src/auth/compose.ts",
    "cloud/src/worker.ts",
  ]) {
    const target = posix.relative(posix.dirname(path), mint);
    const text = `import { mintIdentity } from "${target}"; export function createOAuthAdapter() { async function verifyProviderToken(claims) { return mintIdentity(claims); } return { verify: verifyProviderToken }; }`;
    expect(
      findIdentityMintViolations([{ path, text }]).map((v) => v.file),
    ).toEqual(
      path === "cloud/src/adapters/workers-oauth/index.ts" ? [] : [path],
    );
  }
}, 30_000);

test("the OAuth file refuses direct mints outside its private token-validation function", () => {
  const path = "cloud/src/adapters/workers-oauth/index.ts";
  for (const code of [
    "mintIdentity(claims);",
    "function other() { return mintIdentity(claims); }",
    "function verifyProviderToken() { return mintIdentity(claims); }",
    "function createOAuthAdapter() { function other() { return mintIdentity(claims); } }",
    "function createOAuthAdapter() { function verifyProviderToken() { return () => mintIdentity(claims); } }",
    "function createOAuthAdapter() { function verifyProviderToken() { return { other() { return mintIdentity(claims); } }; } }",
    'import { mintIdentity as é } from "TARGET"; export function other(c) { return é(c); }',
    'import { mintIdentity as mint } from "TARGET"; export function other(c) { return mint(c); }',
    'import * as identity from "TARGET"; export function other(c) { return identity.mintIdentity(c); }',
    'export { mintIdentity } from "TARGET";',
    'import mint from "TARGET"; export function other(c) { return mint(c); }',
    'import { mintIdentity } from "TARGET"; import { isVerifiedIdentity } from "TARGET";',
    'import { mintIdentity } from "TARGET"; export function createOAuthAdapter() { function verifyProviderToken() { return expose(mintIdentity); } }',
  ]) {
    const target = "../../../../src/ports/identity-mint.ts";
    const text = code.includes("TARGET")
      ? code.replaceAll("TARGET", target)
      : `import { mintIdentity } from "${target}"; ${code}`;
    expect(
      findIdentityMintViolations([{ path, text }]).map((v) => v.file),
    ).toEqual([path]);
  }
}, 30_000);

test("the real tree mints identities only at verifier boundaries", () => {
  expect(
    format(
      findIdentityMintViolations(
        readRepoFiles(paths.filter((path) => CODE_FILE.test(path))),
      ),
    ),
  ).toEqual([]);
}, 30_000);

for (const path of [
  "src/assembly/identity.ts",
  "src/ports/identity.ts",
  "src/adapters/other/index.ts",
  "bin/forge.ts",
  "cloud/src/worker.ts",
  "team/identity.ts",
]) {
  for (const [name, source] of Object.entries(fixtures)) {
    test(`${path} refuses minting through ${name}`, () => {
      const target = posix.relative(posix.dirname(path), mint);
      const text = source.replace("TARGET", target);
      const found = findIdentityMintViolations([{ path, text }]);
      expect(found.map((violation) => violation.file)).toEqual([path]);
      expect(found[0]?.message).toContain("identity-mint");
    }, 30_000);
  }
}

for (const path of [
  "src/adapters/oidc/index.ts",
  "test/contract/lib/identity-verifier.ts",
]) {
  test(`${path} may mint verified identities`, () => {
    const target = posix.relative(posix.dirname(path), mint);
    const text = fixtures["named import"]!.replace("TARGET", target);
    expect(findIdentityMintViolations([{ path, text }])).toEqual([]);
  }, 30_000);
}

test("comments, strings and neighboring modules do not mint", () => {
  expect(
    findIdentityMintViolations([
      {
        path: "src/core/example.ts",
        text: '// import { mintIdentity } from "../ports/identity-mint.ts";\nconst example = \'import("../ports/identity-mint.ts")\';',
      },
      {
        path: "src/assembly/identity.ts",
        text: 'import { isVerifiedIdentity } from "../ports/identity.ts";',
      },
    ]),
  ).toEqual([]);
}, 30_000);

const reexports = readJson(
  "test/structure/fixtures/identity-mint-reexports.json",
) as Record<string, string>;

for (const path of [
  "src/adapters/oidc/bridge.ts",
  "test/contract/lib/identity-verifier.ts",
  "cloud/src/adapters/workers-oauth/index.ts",
]) {
  for (const [name, source] of Object.entries(reexports)) {
    test(`verifier refuses ${name} mint re-export to public code`, () => {
      const text = source.replace(
        "TARGET",
        posix.relative(posix.dirname(path), mint),
      );
      const found = findIdentityMintViolations([
        { path, text },
        {
          path: "src/assembly/consumer.ts",
          text: `import { mintIdentity } from "${posix.relative("src/assembly", path)}";`,
        },
      ]);
      expect(found.map((violation) => violation.file)).toContain(path);
      expect(found[0]?.message).toContain("re-exported");
    }, 30_000);
  }
}

for (const path of [
  "test/contract/lib/other-verifier.ts",
  "test/adapters/oidc/fixture.test.ts",
  "test/contract/lib/identity-verifier.ts.backup.ts",
]) {
  test(`${path} cannot import minting directly`, () => {
    const text = fixtures["named import"]!.replace(
      "TARGET",
      posix.relative(posix.dirname(path), mint),
    );
    expect(
      findIdentityMintViolations([{ path, text }]).map((v) => v.file),
    ).toEqual([path]);
  }, 30_000);
}

for (const path of [
  "src/adapters/oidc/other.test.ts",
  "src/adapters/oidc/other.spec.ts",
  "src/adapters/oidc/identity-mint.test.backup.test.ts",
]) {
  test(`${path} cannot use the mint unit test exemption`, () => {
    const text = fixtures["named import"]!.replace(
      "TARGET",
      posix.relative(posix.dirname(path), mint),
    );
    const found = findIdentityMintViolations([
      { path, text },
      {
        path: "src/assembly/consumer.ts",
        text: `import "${posix.relative("src/assembly", path)}";`,
      },
    ]);
    expect(found.map((violation) => violation.file)).toEqual([path]);
    expect(found[0]?.message).toContain("identity-mint");
  }, 30_000);
}

const calls = readJson(
  "test/structure/fixtures/identity-mint-calls.json",
) as Record<string, string>;

for (const path of [
  "src/adapters/oidc/index.ts",
  "src/adapters/oidc/identity-mint.test.ts",
  "test/contract/lib/identity-verifier.ts",
]) {
  for (const [name, source] of Object.entries(calls)) {
    test(`${path} permits a ${name} without exposing the binding`, () => {
      const text = source.replace(
        "TARGET",
        posix.relative(posix.dirname(path), mint),
      );
      expect(
        findIdentityMintViolations([
          { path, text },
          {
            path: "src/assembly/consumer.ts",
            text: `import { verify } from "${posix.relative("src/assembly", path)}";`,
          },
        ]),
      ).toEqual([]);
    }, 30_000);
  }
}
