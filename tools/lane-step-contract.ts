export interface InspectRequest {
  readonly issue: string;
  readonly brief: {
    readonly path: string;
    readonly digest: string;
  };
  readonly workspace: string;
  readonly branch: string;
  readonly expectedHead: string;
}

export interface LaneStepContext {
  readonly issue: string;
  readonly workspace: string;
  readonly branch: string;
  readonly head: string;
  readonly digest: string;
}

export type InspectRefusal = {
  readonly status: "refused";
  readonly field: string;
  readonly code:
    | "not_built"
    | "INPUT_INVALID"
    | "LANE_NOT_FOUND"
    | "BRIEF_DIGEST_MISMATCH"
    | "LEASE_EXPIRED"
    | "LEASE_NOT_HELD"
    | "CONTEXT_MISMATCH"
    | "WORKTREE_DIRTY"
    | "UNAVAILABLE";
};

export type InspectResult =
  | { readonly status: "context"; readonly context: LaneStepContext }
  | InspectRefusal;
