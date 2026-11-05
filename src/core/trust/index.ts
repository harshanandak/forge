import { createHash } from "node:crypto";
import { ForgeFailure } from "../../contract/failure.ts";
import { validateSecretRef } from "../../generated/validators.ts";
import type { Caller, SecretRef } from "../../generated/types.ts";

export function refuse(code: string, message: string): never {
  throw new ForgeFailure({ code, message, retry: "never" });
}

export function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export interface TrustRecord {
  readonly admitted: boolean;
  readonly effects: readonly string[];
}

/** The embedding binds persistence to its state owner; reads never create storage. */
export interface TrustRecords {
  get(digest: string): TrustRecord | undefined;
  set(digest: string, record: TrustRecord): void;
  delete(digest: string): void;
}

declare const ownerApproval: unique symbol;
export interface OwnerApproval {
  readonly [ownerApproval]: true;
}
export type ApprovalValidator = (
  approval: OwnerApproval,
  op: string,
  input: unknown,
) => boolean;

/** The embedding owns approval evidence; block services never receive this store. */
export class TrustStore {
  readonly #records: TrustRecords;
  readonly #approve: ApprovalValidator;

  constructor(
    records: TrustRecords = new Map<string, TrustRecord>(),
    approve: ApprovalValidator = () => false,
  ) {
    this.#records = records;
    this.#approve = approve;
  }

  admit(approval: OwnerApproval, capturedDigest: string): void {
    if (!this.#approve(approval, "block.admit", { digest: capturedDigest }))
      refuse("APPROVAL_REQUIRED", "Admission requires an owner approval proof");
    this.#records.set(capturedDigest, {
      admitted: true,
      effects: this.#records.get(capturedDigest)?.effects ?? [],
    });
  }

  revoke(caller: Caller, capturedDigest: string): void {
    if (caller !== "human")
      refuse("GRANT_REQUIRED", "only a human may revoke trust");
    this.#records.delete(capturedDigest);
  }

  grant(
    approval: OwnerApproval,
    capturedDigest: string,
    effects: readonly string[],
  ): void {
    if (
      !this.#approve(approval, "config.grant", {
        digest: capturedDigest,
        effects,
      })
    )
      refuse("APPROVAL_REQUIRED", "Grant requires an owner approval proof");
    const previous = this.#records.get(capturedDigest);
    this.#records.set(capturedDigest, {
      admitted: previous?.admitted ?? false,
      effects: [...new Set([...(previous?.effects ?? []), ...effects])],
    });
  }

  check(capturedDigest: string, effects: readonly string[]): void {
    const record = this.#records.get(capturedDigest);
    if (record?.admitted !== true)
      refuse("ADMISSION_REQUIRED", "captured bytes need human admission");
    if (effects.some((effect) => !record.effects.includes(effect))) {
      refuse(
        "GRANT_REQUIRED",
        "declared effects need human grants for these captured bytes",
      );
    }
  }
}

/** Resolve only a validated reference; plaintext is never accepted at this boundary. */
export function secretReference(value: unknown): SecretRef {
  const checked = validateSecretRef(value);
  if (!checked.ok) refuse("INPUT_INVALID", "expected a SecretRef");
  return Object.freeze({ ...checked.value });
}
