// Decoding and encoding config text; the YAML adapter implements it. Decoding is an untrusted-input
// boundary, so it takes parse limits.
import type { ForgeError, ParseLimits } from "../generated/types.ts";

export type DecodeResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: ForgeError };

export interface ConfigCodecPort {
  decode(text: string, limits: ParseLimits): DecodeResult;
  encode(value: unknown): string;
  edit?(
    text: string,
    edits: readonly ConfigTextEdit[],
  ): { text: string; formattingLost: boolean };
}

export interface ConfigTextEdit {
  readonly path: readonly (string | number)[];
  /** Move an existing short-form value to its explicit path before replacing it. */
  readonly from?: readonly (string | number)[];
  /** Omitted means delete. */
  readonly value?: unknown;
}
