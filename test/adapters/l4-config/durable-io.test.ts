import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePrivateTextAtomic,
  type DurableWriteFn,
} from "../../../src/adapters/fs/durable-io.ts";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "forge-durable-io-"));
}

test("a short write is retried until every byte is published", () => {
  const root = dir();
  try {
    const target = join(root, "private.txt");
    const text = "short writes must not truncate\n".repeat(64);
    let calls = 0;
    const partial: DurableWriteFn = (fd, buffer, offset, length) => {
      calls++;
      return writeSync(fd, buffer, offset, Math.min(7, length));
    };
    writePrivateTextAtomic(target, text, partial);
    expect(calls).toBeGreaterThan(1);
    expect(readFileSync(target, "utf8")).toBe(text);
    expect(readdirSync(root)).toEqual(["private.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a write that makes no progress throws and leaves the target alone", () => {
  const root = dir();
  try {
    const target = join(root, "private.txt");
    writeFileSync(target, "old content\n");
    let message = "";
    try {
      writePrivateTextAtomic(target, "new content\n", () => 0);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Private file write made no progress");
    expect(message).not.toContain(target);
    expect(message).not.toContain(root);
    expect(readFileSync(target, "utf8")).toBe("old content\n");
    expect(readdirSync(root)).toEqual(["private.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
