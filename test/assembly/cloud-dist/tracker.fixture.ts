import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { project } from "../../cloud/import-current-state.fixture.ts";
import { cloudRig, type CloudRig, type Seen } from "./fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

/** Only the HTTPS boundary is adapted; Project.fetch owns tokens, receipts and leases. */
export async function trackerRig(bin: string) {
  let unavailable = false;
  const authority = await project(
    undefined,
    { FORGE_CLOUD_PROJECT: "proj", FORGE_CLOUD_ID_PREFIX: "forge" },
    () => {
      if (unavailable) throw new Error("synthetic storage outage");
    },
  );
  const clients: CloudRig[] = [];
  const responses: { status: number; body: unknown }[] = [];
  const ids: string[] = [];
  const forward = async (seen: Seen) => {
    const response = await authority.p.fetch(
      new Request(`https://fixture.example${seen.url}`, {
        method: seen.method ?? "POST",
        headers: {
          authorization: seen.authorization ?? "",
          "content-type": "application/json",
        },
        ...(seen.body === undefined ? {} : { body: JSON.stringify(seen.body) }),
      }),
    );
    const answer = { status: response.status, body: await response.json() };
    responses.push(answer);
    return answer;
  };
  const close = async () => {
    try {
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      authority.close();
    }
  };
  try {
    const devices = ["laptop", "desktop", "third", "fresh-checkout"];
    for (const [index, device] of devices.entries()) {
      const session = `installed-${index}`;
      // Administrative setup goes through the real Project routes as well.
      const issued = await authority.send("devices", {
        device,
        session,
        // A default one-hour claim must end before the credential expires.
        ttlMs: 86_400_000,
      });
      assert.equal(issued.r.ok, true);
      const credential = issued.r.value as {
        id: string;
        token: string;
        device: string;
        expiresAt: string;
      };
      ids.push(credential.id);
      clients.push(
        await cloudRig(bin, forward, false, {
          credential: {
            id: credential.id,
            token: credential.token,
            device: credential.device,
            expiresAt: credential.expiresAt,
            localDevice: device,
          },
          session,
        }),
      );
    }
    return {
      clients,
      responses,
      outage(value: boolean) {
        unavailable = value;
      },
      async revoke(index: number) {
        const revoked = await authority.send("revoke", { id: ids[index] });
        assert.equal(revoked.r.ok, true);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
