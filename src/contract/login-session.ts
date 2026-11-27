import { hasDeviceCredential } from "./credential-shape.ts";
export function isLoginSession(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[^A-Za-z0-9_.!~*'():+%-]/.test(value) &&
    !hasDeviceCredential(value)
  );
}
