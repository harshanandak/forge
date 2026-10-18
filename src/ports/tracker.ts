// forge.tracker@1 as types. A tracker block provides it under its own noun; the declaration its
// manifest is checked against is schemas/interfaces/forge.tracker.json.
import type {
  ClaimInput,
  CloseInput,
  CommentInput,
  CommentOutput,
  CreateItemInput,
  ItemRef,
  LeaseGrant,
  ListItemsInput,
  ListItemsOutput,
  TrackerItem,
  UpdateItemInput,
} from "../generated/types.ts";

export const TRACKER_INTERFACE = "forge.tracker@1";

/** Each verb's [input, output]. */
export interface TrackerVerbs {
  readonly create: readonly [CreateItemInput, TrackerItem];
  readonly show: readonly [ItemRef, TrackerItem];
  readonly list: readonly [ListItemsInput, ListItemsOutput];
  readonly update: readonly [UpdateItemInput, TrackerItem];
  readonly comment: readonly [CommentInput, CommentOutput];
  readonly claim: readonly [ClaimInput, LeaseGrant];
  readonly renew: readonly [ClaimInput, LeaseGrant];
  readonly release: readonly [ItemRef, ItemRef];
  readonly close: readonly [CloseInput, TrackerItem];
}

/** The operation map a provider declares under `noun`, for use with Operations<…>. */
export type TrackerOperations<Noun extends string> = {
  readonly [
    Verb in keyof TrackerVerbs as `${Noun}.${Verb}`
  ]: TrackerVerbs[Verb];
};
