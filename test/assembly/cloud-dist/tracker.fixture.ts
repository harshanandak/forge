import assert from "node:assert/strict";
import { project } from "../../cloud/import-current-state.fixture.ts";
import { cloudRig, refuse, type CloudRig, type Seen } from "./fixture.ts";

/** Only the HTTPS boundary is adapted; Project.fetch owns tokens, receipts and leases. */
export async function trackerRig(bin: string) {
  const authority = await project(undefined, { FORGE_CLOUD_PROJECT: "proj" });
  const clients: CloudRig[] = [];
  const ids: string[] = [];
  let unavailable = false;
  const forward = async (seen: Seen) => {
    if (unavailable) return refuse("UNAVAILABLE", 503, "synthetic outage");
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
    return { status: response.status, body: await response.json() };
  };
  const close = async () => {
    try {
      await Promise.all(clients.map((client) => client.close()));
    } finally {
      authority.close();
    }
  };
  try {
    for (const [index, device] of [
      "laptop",
      "desktop",
      "third",
      "fresh-checkout",
    ].entries()) {
      const session = `installed-${index}`;
      // Administrative setup goes through the real Project routes as well.
      const issued = await authority.send("devices", {
        device,
        session,
        ttlMs: 3_600_000,
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
