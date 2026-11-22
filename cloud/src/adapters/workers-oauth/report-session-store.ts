import { appReply as reply, SESSION_AGE } from "../../report-http.ts";
import { sha256 } from "../../tokens.ts";
import type { ClaimState } from "./redemption.ts";
import type { RedemptionNamespace as Namespace } from "./redemption.ts";

export const REPORT_PATH = "/__forge/report-session";
const KEY = "report-session";

type RecordOperation = "GET" | "DELETE" | number;
export async function record(ns: Namespace, id: string, op: RecordOperation) {
  const name = "forge-report-session:v1:" + (await sha256(id));
  const method = typeof op === "number" ? "POST" : op;
  const url = "https://redemption.internal" + REPORT_PATH;
  const target = method === "POST" ? url + "?until=" + op : url;
  const stub = ns.get(ns.idFromName(name));
  return (await stub.fetch(new Request(target, { method }))).status;
}

type Store = ClaimState["storage"];
type Clock = { now(): number };
export async function reportStore(req: Request, storage: Store, clock: Clock) {
  if (req.method === "DELETE") {
    await storage.deleteAll();
    return reply(204);
  }
  if (req.method === "GET") {
    const until = await storage.get<number>(KEY);
    if (until === undefined) return reply(401);
    if (clock.now() < until) return reply(200, undefined, String(until));
    await storage.deleteAll();
    return reply(401);
  }
  if (req.method !== "POST") return reply(405, { Allow: "POST, GET, DELETE" });
  const until = Number(new URL(req.url).searchParams.get("until"));
  const left = until - clock.now();
  const inRange = left > 0 && left <= SESSION_AGE * 1000;
  if (!Number.isSafeInteger(until) || !inRange) return reply(400);
  return storage.transaction(async (store) => {
    if ((await store.get(KEY)) !== undefined) return reply(409);
    await store.put(KEY, until);
    await store.setAlarm(until);
    return reply(204);
  });
}
