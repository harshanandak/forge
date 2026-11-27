export const reasons = [
  "network_error",
  "http_status",
  "api_rate_limited",
  "json_invalid",
  "api_field_invalid",
  "pages_incomplete",
  "bot_format_unsupported",
  "bot_version_unsupported",
  "bot_format_malformed",
  "bot_state_invalid",
  "bot_state_conflict",
  "bot_head_invalid",
  "bot_identity_mismatch",
  "other_bot_unsupported",
] as const;
export type Reason = (typeof reasons)[number];
type Failure = { ok: false; reason: Reason; where: string };
export type Result<T> = { ok: true; value: T } | Failure;
export const ok = <T>(value: T) => ({ ok: true as const, value });
export const fail = (reason: Reason, where: string): Failure => ({
  ok: false,
  reason,
  where,
});
