import { expect, mock, spyOn, test } from "bun:test";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { composeOAuth } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
const { boundedOAuthRequest } =
  await import("../../../cloud/src/adapters/workers-oauth/body.ts");
const limit = 8192;
const oversized = {
  error: "invalid_request",
  error_description: "Request body exceeds 8192 bytes",
};

function fixture(
  path: string,
  size: number,
  chunkSize: number,
  length?: number,
) {
  const { options } = createOAuthHarness();
  const calls = [
    spyOn(options.storage, "get"),
    spyOn(options.storage, "put"),
    spyOn(options.storage, "delete"),
    spyOn(options.storage, "list"),
    spyOn(options.codeRedemption, "claimOnce"),
    spyOn(options.upstream, "begin"),
    spyOn(options.upstream, "verify"),
  ];
  const prefix =
    path === "/authorize"
      ? "allow=false&handle=missing&pad="
      : "grant_type=authorization_code&code=person:grant:secret&pad=";
  const padding = size - prefix.length;
  const bytes = new TextEncoder().encode(
    prefix + "é".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2),
  );
  let read = 0;
  const cancel = mock(() => undefined);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (read === bytes.byteLength) return controller.close();
        const chunk = bytes.slice(read, read + chunkSize);
        read += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (length !== undefined) headers.set("Content-Length", String(length));
  const request = new Request(`${options.issuer}${path}`, {
    method: "POST",
    headers,
    body,
  });
  const clone = spyOn(request, "clone");
  const parse = spyOn(request, "formData");
  const auth = composeOAuth(options, options.resources[0]!);
  return {
    send: () => auth.route(request),
    read: () => read,
    cancel,
    calls,
    clone,
    parse,
  };
}

async function refused(f: ReturnType<typeof fixture>) {
  const response = await f.send();
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(oversized);
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.clone).toHaveBeenCalledTimes(0);
  expect(f.parse).toHaveBeenCalledTimes(0);
  for (const call of f.calls) expect(call).toHaveBeenCalledTimes(0);
}

test("bounded token requests preserve all form fields and cookies", async () => {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: "person:grant:secret+with/symbols=",
    client_id: "public-client",
    redirect_uri: "https://client.example/callback?channel=desktop&x=1",
    code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    resource: "https://api.example/a",
  });
  form.append("resource", "https://api.example/b");
  const request = new Request("https://auth.example/oauth/token", {
    method: "POST",
    headers: { Cookie: "session=fixture" },
    body: form,
  });
  const bounded = await boundedOAuthRequest(request);
  expect(bounded).toBeInstanceOf(Request);
  if (!(bounded instanceof Request)) throw new Error("Unexpected refusal");
  expect([...(await bounded.formData())]).toEqual([...form]);
  expect(bounded.url).toBe(request.url);
  expect(bounded.method).toBe("POST");
  expect(bounded.headers.get("Cookie")).toBe("session=fixture");
  expect(bounded.headers.get("Content-Type")).toBe(
    request.headers.get("Content-Type"),
  );
}, 30_000);

for (const path of ["/authorize", "/oauth/token"]) {
  test(`${path} refuses and cancels a body one byte over the limit`, async () => {
    const f = fixture(path, limit + 1, limit + 1);
    await refused(f);
    expect(f.read()).toBe(limit + 1);
  }, 30_000);

  for (const length of [undefined, 1]) {
    test(`${path} counts streamed bytes with Content-Length ${length}`, async () => {
      const chunk = 257;
      const f = fixture(path, limit + chunk * 4, chunk, length);
      await refused(f);
      expect(f.read()).toBeGreaterThan(limit);
      expect(f.read()).toBeLessThanOrEqual(limit + chunk);
    }, 30_000);
  }

  test(`${path} refuses an oversized declared length before reading a small body`, async () => {
    const f = fixture(path, 128, 64, limit + 1);
    await refused(f);
    expect(f.read()).toBe(0);
  }, 30_000);

  test(`${path} accepts exactly the byte limit for normal form validation`, async () => {
    const f = fixture(path, limit, 257, limit);
    const response = await f.send();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: path === "/authorize" ? "invalid_request" : "invalid_grant",
    });
    expect(f.read()).toBe(limit);
    expect(f.cancel).toHaveBeenCalledTimes(0);
  }, 30_000);
}
