/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const timeout = 30_000;
const seamExports = [
  "Tx",
  "StoreDeps",
  "UnreadCounts",
  "AnswerAfter",
  "ActionResult",
  "DigitResult",
  "AskEditJob",
  "AnswerRow",
  "SessionStore",
  "CredentialStore",
  "AskStore",
  "Guards",
  "CoreStore",
  "CreateCoreStore",
  "RefuseNetworkPath",
];

test(
  "C3: the store seam is types only and exposes every frozen name",
  () => {
    const source = readFileSync(
      new URL("../../src/core/store.ts", import.meta.url),
      "utf8",
    );
    const exports = [
      ...source.matchAll(/^export (?:type|interface) (\w+)/gm),
    ].map((match) => match[1]);
    expect(exports).toEqual(seamExports);
    expect(source).not.toMatch(
      /\b(?:function|class|const|let|var|enum|namespace)\b|=>\s*\{|\/\/|\/\*/,
    );
    expect(source).not.toMatch(
      /^import\s+(?!type\b)|^export\s+(?!type\b|interface\b)/m,
    );
  },
  timeout,
);
