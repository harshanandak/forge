import { createHash } from "node:crypto";
import type {
  ProcessOutputEvidence,
  SpawnOptions,
} from "../../ports/process.ts";

/** Bounded previews and an incremental digest; discarded bytes are never buffered. */
export class StreamCapture {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private total = 0;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly hash;

  constructor(limit: number, capture?: SpawnOptions["capture"]) {
    this.headLimit = capture?.headBytes ?? limit;
    this.tailLimit = capture?.tailBytes ?? 0;
    this.hash = capture ? createHash("sha256") : undefined;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (!Number.isSafeInteger(this.total))
      throw new RangeError("Output byte count exceeds safe integer range");
    this.hash?.update(chunk);
    const take = Math.min(chunk.length, this.headLimit - this.head.length);
    if (take > 0)
      this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
    const rest = chunk.subarray(take);
    if (this.tailLimit && rest.length) {
      this.tail =
        rest.length >= this.tailLimit
          ? Buffer.from(rest.subarray(-this.tailLimit))
          : Buffer.from(
              Buffer.concat([this.tail, rest]).subarray(-this.tailLimit),
            );
    }
  }

  get truncated(): boolean {
    return this.total > this.headLimit + this.tailLimit;
  }
  text(): string {
    return Buffer.concat([this.head, this.tail]).toString("utf8");
  }
  evidence(complete: boolean): ProcessOutputEvidence {
    if (!this.hash) throw new Error("Stream evidence was not requested");
    return {
      head: this.head.toString("base64"),
      tail: this.tail.toString("base64"),
      encoding: "base64",
      totalBytes: this.total,
      digest: "sha256:" + this.hash.copy().digest("hex"),
      complete,
    };
  }
}
