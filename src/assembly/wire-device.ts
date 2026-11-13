import { createHash } from "node:crypto";

const WIRE_DEVICE = /^[A-Za-z0-9][\w.:-]{0,127}$/;

/**
 * The device id sent to the Worker. An id the Worker accepts goes unchanged; any other becomes
 * `device-` plus the SHA-256 of the full local id. The local device-id file never changes, and
 * whatever compares holder identity later must apply this same mapping. It lives apart from the
 * cloud client so a routed call can refuse another machine's device before loading that client.
 */
export function wireDeviceId(local: string): string {
  return WIRE_DEVICE.test(local)
    ? local
    : `device-${createHash("sha256").update(local).digest("hex")}`;
}
