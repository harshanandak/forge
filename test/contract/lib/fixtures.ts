import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Actor,
  AmbientContext,
  BlockManifest,
  DeviceScope,
  InvocationRequest,
  ProjectIdentity,
  Session,
} from "../../../src/contract/index.ts";

const FIXTURES = new URL("../fixtures/", import.meta.url);

export function fixture(path: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(path, FIXTURES)), "utf8"),
  );
}

export function firstPartyManifests(): Map<string, BlockManifest> {
  const all = fixture("blocks/first-party/manifests.json") as Record<
    string,
    BlockManifest
  >;
  return new Map(Object.entries(all));
}

export const alice: Actor = { kind: "agent", id: "agent-alice" };
export const project: ProjectIdentity = { id: "fixture-project" };
export const device: DeviceScope = { id: "fixture-device" };
export const session: Session = { id: "session-1" };

let counter = 0;

export function request(
  op: string,
  input: unknown,
  context: AmbientContext,
): InvocationRequest {
  counter += 1;
  return {
    schemaVersion: "forge.invocation/1",
    requestId: `req-${counter}`,
    op,
    input,
    caller: "agent",
    context,
  };
}
