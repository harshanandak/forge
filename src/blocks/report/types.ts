import type { StateClient } from "../../ports/state.ts";

export type ReportKind = "bug" | "wrong" | "suggest" | "missing";
export interface ReportInput {
  readonly message: string;
  readonly kind?: ReportKind;
}

export interface ReportHost {
  readonly labels: readonly string[];
  readonly context: Readonly<Record<string, string>>;
  now(): number;
}

export interface ReportServices {
  readonly state: Pick<StateClient, "get" | "put"> & {
    readonly host: ReportHost;
  };
  readonly crypto: { sha256(text: string): string };
}
