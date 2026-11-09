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
