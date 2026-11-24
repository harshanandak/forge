export const reasons: readonly string[] = [];

export type Reason =
  | "network_error"
  | "http_status"
  | "api_rate_limited"
  | "json_invalid"
  | "api_field_invalid"
  | "pages_incomplete";

export type Result<T> =
  { ok: true; value: T } | { ok: false; reason: Reason; where: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = (reason: Reason, where: string): Result<never> => ({
  ok: false,
  reason,
  where,
});
