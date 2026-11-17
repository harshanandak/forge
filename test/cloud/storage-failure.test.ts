import { test, expect } from "bun:test";
import {
  storageFailure,
  storageResponse,
} from "../../cloud/src/storage-failure.ts";
import { createWorker } from "../../cloud/src/worker.ts";

const messages = [
  [
    "Exceeded allowed rows written in Durable Objects free tier.",
    "QUOTA_EXHAUSTED",
  ],
  [
    "Exceeded allowed rows read in Durable Objects free tier.",
    "QUOTA_EXHAUSTED",
  ],
  ["database or disk is full: SQLITE_FULL", "STORAGE_LIMIT_EXCEEDED"],
  ["string or blob too big: SQLITE_TOOBIG", "STORAGE_LIMIT_EXCEEDED"],
] as const;
test.each(messages)("storage refusal sanitizes %s", async (message, code) => {
  const response = storageResponse(new Error(message), true)!;
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({
    ok: false,
    status: "FAIL",
    warnings: [],
    error: {
      code,
      message:
        code === "QUOTA_EXHAUSTED"
          ? "Durable Object daily quota exhausted; retry after 00:00 UTC"
          : "Project storage limit exceeded",
      retry: code === "QUOTA_EXHAUSTED" ? "safe" : "never",
    },
  });
  expect(body).not.toContain(message);
});
test.each([
  undefined,
  "SQLITE_FULL",
  new Error("quota"),
  new Error("database is corrupt"),
  new Error(
    "caller says Exceeded allowed rows written in Durable Objects free tier.",
  ),
])("unknown storage cause remains unclassified: %s", (error) =>
  expect(storageFailure(error)).toBeUndefined(),
);
test.each(["command", "state/read", "state/commit", "loginstart", "claim"])(
  "binding quota failure on %s retains its route envelope",
  async (route) => {
    const typed = route === "command" || route.startsWith("state/");
    const response = await createWorker().fetch(
      new Request(`https://forge.test/p/quota/${route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer fct_${"a".repeat(16)}.${"b".repeat(43)}`,
        },
        body: "{}",
      }),
      {
        FORGE_CLOUD_PROJECT: "quota",
        CLERK_ISSUER: "https://clerk.test",
        FORGE_OWNER_SUBJECT: "synthetic-owner",
        DEVICE_LOGIN_HMAC_KEY: "A".repeat(43),
        CLERK_CLIENT_ID: "synthetic-client",
        PROJECTS: {
          idFromName: (name) => name,
          get: () => ({
            fetch: () => Promise.reject(new Error(messages[0][0])),
          }),
        },
      },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { code: string };
      status?: string;
    };
    expect(body.error.code).toBe("QUOTA_EXHAUSTED");
    expect(body.status).toBe(typed ? "FAIL" : undefined);
  },
);
