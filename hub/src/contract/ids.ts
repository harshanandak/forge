export const ID_PATTERN = /^[a-z]{2,8}_[A-Za-z0-9_-]{1,64}$/;
export const ISSUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ID_PREFIX = {
  person: "per",
  project: "prj",
  session: "ses",
  conversation: "cnv",
  item: "itm",
  ask: "ask",
  permit: "pmt",
  token: "tok",
  hostInstance: "hst",
  ring: "ring",
  summaryPublication: "sum",
} as const;
export type IdKind = keyof typeof ID_PREFIX;
export const TOKEN_PREFIX = "fh_";
export const TOKEN_PATTERN = /^fh_[A-Za-z0-9_-]{43}$/;
export const HOST_KEY_PREFIX = "fhk_";
export const HOST_KEY_PATTERN = /^fhk_[A-Za-z0-9_-]{43}$/;
