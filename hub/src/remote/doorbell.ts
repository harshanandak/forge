import { createHmac } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
  DOORBELL_SIGNATURE_HEADER,
  type DoorbellPayload,
  type DoorbellPort,
} from "../contract/hooks.ts";
import { ID_PATTERN } from "../contract/ids.ts";
import type * as Runtime from "../contract/runtime.ts";

interface DoorbellServices {
  fetch(url: URL, init: RequestInit): Promise<Response>;
  delay(ms: number): Promise<void>;
}

function envName(
  name: string,
): name is Extract<Runtime.SecretName, `FORGE_DOORBELL_${string}`> {
  return name.startsWith("FORGE_DOORBELL_");
}

function endpoint(value: string) {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.hash) return;
  if (url.protocol === "https:") return url;
  const loopback = /^(127(?:\.\d{1,3}){3}|\[::1\])$/.test(url.hostname);
  if (url.protocol === "http:" && loopback) return url;
}

const isId = (id: unknown) => typeof id === "string" && ID_PATTERN.test(id);
const isIdList = (ids: unknown) => Array.isArray(ids) && ids.every(isId);

function wire(input: DoorbellPayload) {
  const { v, ring, person, project, session, conversation, items, answers } =
    input;
  if (v !== 1 || !isIdList(items) || !isIdList(answers)) return;
  if (![ring, person, project].every(isId)) return;
  if (session !== undefined && !isId(session)) return;
  if (conversation !== undefined && !isId(conversation)) return;
  return JSON.stringify({
    v,
    ring,
    person,
    project,
    session,
    conversation,
    items,
    answers,
  });
}

export const createDoorbell: Runtime.CreateDoorbell = (deps) =>
  doorbellWith(deps, {
    fetch: (url, init) => fetch(url, init),
    delay: setTimeout,
  });

export function doorbellWith(
  { config, secret, log }: Runtime.DoorbellDeps,
  services: DoorbellServices,
): DoorbellPort {
  function target(person: string, project: string) {
    const entry = config.doorbells.find(
      (row) => row.personId === person && row.projectId === project,
    );
    if (!entry || !envName(entry.urlEnv) || !envName(entry.secretEnv)) return;
    const url = endpoint(secret(entry.urlEnv) ?? "");
    const key = url && secret(entry.secretEnv);
    if (url && key) return { url, key };
  }
  return {
    configured: (person, project) => target(person, project) !== undefined,
    async ring(payload) {
      const body = wire(payload);
      if (body === undefined) return { kind: "failed" };
      const { ring, person, project } = payload;
      const selected = target(person, project);
      if (!selected) return { kind: "not_configured" };
      const signature = createHmac("sha256", selected.key)
        .update(body)
        .digest("hex");
      const headers = {
        "content-type": "application/json",
        [DOORBELL_SIGNATURE_HEADER]: "sha256=" + signature,
      };
      const attempt = async () => {
        try {
          const signal = AbortSignal.timeout(5000);
          const response = await services.fetch(selected.url, {
            method: "POST",
            body,
            headers,
            redirect: "error",
            signal,
          });
          await response.body?.cancel().catch(() => undefined);
          return response.status;
        } catch {
          return undefined;
        }
      };
      let status = await attempt();
      if (
        status === undefined ||
        status >= 500 ||
        [408, 429].includes(status)
      ) {
        await services.delay(30_000);
        status = await attempt();
      }
      const sent = status !== undefined && status >= 200 && status < 300;
      const details = status === undefined ? {} : { status };
      log.info("hub.doorbell", {
        ring,
        person,
        project,
        outcome: sent ? "sent" : "failed",
        ...details,
      });
      if (sent && status !== undefined) return { kind: "sent", status };
      return { kind: "failed", ...details };
    },
  };
}
