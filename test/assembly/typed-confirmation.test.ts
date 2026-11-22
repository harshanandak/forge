import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { typedConfirmation } from "../../src/assembly/index.ts";

const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
let input: PassThrough;
let restoreOutput: () => void;
let written: Buffer[];
beforeEach(() => {
  input = new PassThrough();
  written = [];
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: input,
  });
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(Buffer.from(chunk));
    return true;
  });
  restoreOutput = () => spy.mockRestore();
});
afterEach(() => {
  restoreOutput();
  input.destroy();
  Object.defineProperty(process, "stdin", original);
});

test("a line that arrives in pieces is compared whole", async () => {
  const answer = typedConfirmation("block.admit");
  input.write("  confirm block.");
  input.write("admit\t\r\n");
  expect(await answer).toBe(true);
}, 30_000);

test("stderr prints visible escapes and the confirmation still matches the raw operation", async () => {
  const op = 'block.admit"\\\u202e';
  const answer = typedConfirmation(op, "A heading\nA line\r\u001b\u{e0001}");
  input.write(`confirm ${op}\n`);
  expect(await answer).toBe(true);
  expect(Buffer.concat(written).toString()).toBe(
    'A heading\nA line\\u000d\\u001b\\udb40\\udc01\nOwner confirmation: type "confirm block.admit\\"\\\\\\u202e" to proceed: ',
  );
}, 30_000);

test("closed input, a partial line at end of input and other text all refuse", async () => {
  const partial = typedConfirmation("block.admit");
  input.write("confirm block.adm");
  input.end();
  expect(await partial).toBe(false);
  expect(await typedConfirmation("block.admit")).toBe(false);
  const wrong = new PassThrough();
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: wrong,
  });
  const other = typedConfirmation("block.admit");
  wrong.write("yes\n");
  expect(await other).toBe(false);
  const wrongOp = typedConfirmation("block.admit");
  wrong.write("confirm config.grant\n");
  expect(await wrongOp).toBe(false);
  wrong.destroy();
  expect(await typedConfirmation("block.admit")).toBe(false);
}, 30_000);

test("one typed answer approves one prompt, never two", async () => {
  const first = typedConfirmation("block.admit");
  const second = typedConfirmation("block.admit");
  input.write("confirm block.admit\n");
  expect(await first).toBe(true);
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  input.write("no\n");
  expect(await second).toBe(false);
}, 30_000);
