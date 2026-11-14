import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { access, issue, revoke, send, type Family } from "./oauth.ts";
import { duplicateCanary } from "./refresh-canary.ts";

const refresh = (family: Family, headers: Record<string, string>) =>
  send("/oauth/token", {
    method: "POST",
    headers,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: family.client,
      refresh_token: family.refresh_token,
    }),
  });
async function main() {
  const file = `${process.env.OAUTH_CONFORMANCE_STATE}.refresh`;
  if (process.argv[2] === "restart") {
    const [spent, issued] = JSON.parse(readFileSync(file, "utf8")) as [
      Family,
      Family,
    ];
    assert.equal(
      (await refresh(spent, {})).status,
      400,
      "spent token must refuse after workerd restart",
    );
    await access(spent, false);
    await access(issued, false);
    assert.equal((await refresh(issued, {})).status, 400, "restart descendant");
    console.log(
      "PASS OAuth spent refresh survives workerd restart and revokes its family",
    );
    return;
  }
  const family = await issue(),
    unrelated = await issue(),
    name = crypto.randomUUID();
  const responses = await Promise.all([
    refresh(family, { "x-refresh-race": name }),
    refresh(family, { "x-refresh-race": name }),
  ]);
  const counts = (await (
    await send(`/fixture/refresh-state?group=${name}`)
  ).json()) as { entries: number; arrived: number };
  assert.equal(counts.arrived, 2, "two validated requests");
  const statuses = responses.map((response) => response.status).sort();
  assert.equal(
    counts.entries,
    1,
    `one provider entry required (observed ${counts.entries}; statuses ${statuses.join(",")})`,
  );
  assert.deepEqual(statuses, [200, 400], "one winner and loser");
  const tokens = (await responses
    .find((response) => response.ok)!
    .json()) as Omit<Family, "client">;
  assert.deepEqual(await responses.find((response) => !response.ok)!.json(), {
    error: "invalid_grant",
  });
  await access(family, false);
  await access({ client: family.client, ...tokens }, false);
  assert.equal(
    (await refresh({ client: family.client, ...tokens }, {})).status,
    400,
    "overlap descendant refresh",
  );
  await access(unrelated, true);
  console.log(
    "PASS OAuth real-DO overlap: one provider entry, one response winner, whole family refused",
  );
  for (const parameter of ["extra", "redirect_uri", duplicateCanary]) {
    const untouched = await issue(),
      observed = crypto.randomUUID();
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: untouched.client,
      refresh_token: untouched.refresh_token,
    });
    form.append(parameter, "a");
    form.append(parameter, "b");
    const rejected = await send("/oauth/token", {
      method: "POST",
      headers: { "x-refresh-observe": observed },
      body: form,
    });
    assert.equal(rejected.status, 400, "duplicate extension refresh");
    const text = await rejected.text();
    assert.deepEqual(JSON.parse(text), { error: "invalid_request" });
    assert(
      !text.includes(duplicateCanary),
      "duplicate canary must not reach response",
    );
    assert.equal(rejected.headers.get("cache-control"), "no-store");
    const activity = await (
      await send(`/fixture/refresh-state?group=${observed}`)
    ).json();
    assert.deepEqual(
      activity,
      { entries: 0, arrived: 0 },
      "duplicates must not claim or enter provider",
    );
    const corrected = await refresh(untouched, {});
    assert.equal(corrected.status, 200, "corrected request must still refresh");
    const correctedTokens = (await corrected.json()) as Omit<Family, "client">;
    await access({ client: untouched.client, ...correctedTokens }, true);
  }
  console.log(
    "PASS OAuth duplicate extensions refuse before claim; corrected requests refresh",
  );
  const late = await issue(),
    hold = crypto.randomUUID();
  const pending = refresh(late, { "x-refresh-late": hold });
  assert.equal(
    (await send(`/fixture/refresh-held?group=${hold}`)).status,
    200,
    "provider token write must be held",
  );
  await revoke(late, late.access_token);
  await send(`/fixture/refresh-release?group=${hold}`);
  const winner = await pending;
  assert.equal(winner.status, 200, "late winner completes");
  const lateTokens = (await winner.json()) as Omit<Family, "client">;
  await access({ client: late.client, ...lateTokens }, false);
  assert.equal(
    (await refresh({ client: late.client, ...lateTokens }, {})).status,
    400,
    "refresh after revoke and late write",
  );
  for (const fault of [
    "x-refresh-write-fault",
    "x-refresh-rate-fault",
    "x-refresh-drop",
  ]) {
    const failed = await issue();
    const failedResponse = await refresh(failed, { [fault]: "1" });
    assert.equal(failedResponse.status, 503, `${fault}: claim stays spent`);
    assert.deepEqual(await failedResponse.json(), {
      error: "temporarily_unavailable",
    });
    assert.equal(failedResponse.headers.get("cache-control"), "no-store");
    const retry = await refresh(failed, {});
    assert.equal(retry.status, 400, `${fault}: spent token retry`);
    assert.deepEqual(await retry.json(), { error: "invalid_grant" });
    await access(failed, false);
  }
  console.log(
    "PASS OAuth explicit revoke before late write, provider failure and lost reply stay spent",
  );
  const saved = await issue(),
    response = await refresh(saved, {});
  assert.equal(response.status, 200, "refresh saved for restart");
  const savedTokens = (await response.json()) as Omit<Family, "client">;
  writeFileSync(
    file,
    JSON.stringify([saved, { client: saved.client, ...savedTokens }]),
    { mode: 0o600 },
  );
}
await main().catch((error: unknown) => {
  console.error(
    `FAIL OAuth refresh race: ${error instanceof AssertionError ? `${error.message} (expected ${JSON.stringify(error.expected)}, observed ${JSON.stringify(error.actual)})` : "fixture unavailable"}`,
  );
  console.error(error);
  process.exitCode = 1;
});
