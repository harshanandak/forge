import { expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssembly, localCall } from "../../src/assembly/index.ts";
import { runCli } from "../../src/surface/cli.ts";
import { validateDocsRecords } from "../../src/generated/validators.ts";

setDefaultTimeout(30_000);

const repo = resolve(import.meta.dirname, "../..");

test("the guide's explicit docs shape validates and supplies the authoring journey", () => {
  const guide = readFileSync(join(repo, "docs/writing-a-block.md"), "utf8");
  const example = guide.match(/```json\n([\s\S]*?)```/)?.[1];
  expect(example).toBeDefined();
  const docs: unknown = JSON.parse(example!);
  expect(validateDocsRecords(docs).ok).toBe(true);
  expect(docs).toEqual(
    JSON.parse(
      readFileSync(join(repo, "examples/hello-block/docs.json"), "utf8"),
    ),
  );
});

for (const [docs, sentences] of [
  [
    { operations: { "hello.say": {} } },
    [
      'docs.json: operations["hello.say"].title is required',
      'docs.json: operations["hello.say"].summary is required',
    ],
  ],
  [{ operations: {} }, ['docs.json: operations["hello.say"] is required']],
  [{ operations: [] }, ["docs.json: operations must be object; received []"]],
  [
    { "hello.say": { description: "Hello" } },
    ["docs.json: operations is required"],
  ],
] as const) {
  test(`check and add explain malformed docs: ${JSON.stringify(docs)}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-author-docs-"));
    cpSync(join(repo, "examples/hello-block"), join(root, "hello-block"), {
      recursive: true,
    });
    writeFileSync(join(root, "hello-block/docs.json"), JSON.stringify(docs));
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    try {
      for (const verb of ["check", "add"]) {
        const reply = await runCli(
          assembly.catalog,
          ["block", verb, "./hello-block"],
          localCall(assembly),
        );
        expect(reply.exitCode).toBe(6);
        if (reply.envelope.ok) throw new Error("expected invalid docs");
        expect(reply.envelope.error.code).toBe("INPUT_INVALID");
        for (const sentence of sentences)
          expect(reply.envelope.error.message).toContain(sentence);
      }
    } finally {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("registration succeeds in JSON and text while admission remains explicit", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-author-add-"));
  cpSync(join(repo, "examples/hello-block"), join(root, "hello-block"), {
    recursive: true,
  });
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  try {
    const options = localCall(assembly);
    const added = await runCli(
      assembly.catalog,
      ["block", "add", "./hello-block"],
      options,
    );
    expect(added.exitCode).toBe(0);
    expect(added.envelope.ok).toBe(true);
    if (!added.envelope.ok) throw new Error("expected registration");
    const result = added.envelope.result as {
      digest: string;
      admitted: boolean;
      next: string;
    };
    expect(result.admitted).toBe(false);
    expect(result.next).toBe(`npx forge block admit ${result.digest}`);
    const text = await runCli(
      assembly.catalog,
      ["block", "add", "./hello-block", "--text"],
      options,
    );
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain(`next: ${result.next}`);
    expect(
      assembly.catalog.list().find((c) => c.op === "hello.say")?.admitted,
    ).toBe(false);
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
});
