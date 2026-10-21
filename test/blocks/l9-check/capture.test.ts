import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  captureStreams,
  StreamCapture,
} from "../../../src/adapters/process/capture.ts";

test("stream capture retains bounded head and tail while hashing every byte", () => {
  const bytes = Buffer.from("first\u0000" + "middle".repeat(10000) + "last");
  const capture = new StreamCapture(9, { headBytes: 5, tailBytes: 4 });
  for (let offset = 0; offset < bytes.length; offset += 133)
    capture.push(bytes.subarray(offset, offset + 133));
  expect(capture.evidence(true)).toEqual({
    head: Buffer.from("first").toString("base64"),
    tail: Buffer.from("last").toString("base64"),
    encoding: "base64",
    totalBytes: bytes.length,
    digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    complete: true,
  });
  expect(capture.text()).toBe("firstlast");
  expect(capture.truncated).toBe(true);
}, 1000);

test("JSON escaping and base64 evidence fit the validated ten-byte reservation", () => {
  for (const byte of [0, 255, 65]) {
    const capture = new StreamCapture(2, { headBytes: 1, tailBytes: 1 });
    capture.push(Buffer.alloc(100, byte));
    const evidence = capture.evidence(true);
    const actual = Buffer.byteLength(
      JSON.stringify({ text: capture.text(), evidence }),
    );
    const baseline = Buffer.byteLength(
      JSON.stringify({
        text: "",
        evidence: { ...evidence, head: "", tail: "" },
      }),
    );
    expect(actual - baseline).toBeLessThanOrEqual(20);
  }
}, 1000);

test("the observer sees every byte of both streams, past the capture bounds", () => {
  const seen: string[] = [];
  const { stdout, stderr } = captureStreams({
    cwd: ".",
    env: {},
    timeoutMs: 1000,
    maxOutputBytes: 2,
    capture: { headBytes: 1, tailBytes: 1 },
    observer: {
      push: (stream, chunk) => {
        seen.push(stream + ":" + Buffer.from(chunk).toString());
      },
    },
  });
  stdout.push(Buffer.from("abcdef"));
  stderr.push(Buffer.from("xyz"));
  expect(seen).toEqual(["stdout:abcdef", "stderr:xyz"]);
  expect(stdout.text()).toBe("af");
}, 1000);

test("short, split multibyte and empty captures preserve exact raw-byte digests", () => {
  for (const value of ["", "abc", "a😀b", "😀😀😀"]) {
    const bytes = Buffer.from(value);
    const capture = new StreamCapture(32, { headBytes: 16, tailBytes: 16 });
    for (const byte of bytes) capture.push(Buffer.from([byte]));
    expect(capture.text()).toBe(value);
    expect(capture.evidence(false).digest).toBe(
      "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    );
    expect(capture.evidence(false).complete).toBe(false);
    expect(capture.truncated).toBe(false);
  }
}, 1000);
