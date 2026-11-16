import { StateOwner } from "../../../src/core/state/index.ts";
import { actor, ns, fixture } from "./retention.fixture.ts";

export { actor, ns, fixture };
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function capture(s: Fixture, batch = 2) {
  return (
    s.owner as StateOwner & { checkpoint?: (batch?: number) => number }
  ).checkpoint?.(batch);
}
export const put = (
  s: Fixture,
  key: string,
  value: unknown = {},
  revision = 0,
) => s.owner.put(ns, key, value, actor, { expectRevision: revision });
export const high = (s: Fixture) =>
  Number(s.db.get("SELECT sequence FROM state_retention")!.sequence);
export function prefix(s: Fixture) {
  s.owner.initialize();
  put(s, "kept", { version: 1 });
  put(s, "gone");
  s.owner.delete(ns, "gone", actor, { expectRevision: 1 });
  s.owner.putNext(ns, "item:", () => ({ value: {} }), actor);
  s.owner.delete(ns, "item:1", actor, { expectRevision: 1 });
}
export function tail(s: Fixture) {
  put(s, "kept", { version: 2 }, 1);
  put(s, "gone", { recreated: true });
  s.owner.putNext(ns, "item:", () => ({ value: {} }), actor);
}
