import { expect, mock, test } from "bun:test";
import { createWorker } from "../../cloud/src/worker.ts";
import { digestBytes } from "../../src/core/config/pointer.ts";
import {
  guardFixture,
  noWrites,
  portableUpload,
} from "./v3-project.fixture.ts";

const timeout = 30_000;

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });

test(
  "the worker refuses an unauthenticated or non-admin final v3 restore page",
  async () => {
    const target = guardFixture();
    using _target = target.db;
    const pages = [
      { id: "directory:0", body: "[]" },
      { id: "snapshot:0", body: "" },
      { id: "transcript:0", body: "[]" },
    ];
    const upload = portableUpload(target, {
      pages,
      head: 0,
      eventWatermark: 0,
      recordFloor: 1,
      publicDigest: digestBytes("[]"),
      source: "worker-restore-fixture",
    });
    for (const page of [0, 1])
      expect(await upload(page)).toEqual({
        status: 200,
        body: { ok: true, value: { page, verified: false } },
      });
    const staged = target.snapshot();
    const effects = target.observeEffects();
    const fetch = mock(target.fetch);
    const bindings = {
      ADMIN_TOKEN: "fixture-admin",
      PROJECTS: { idFromName: (name: string) => name, get: () => ({ fetch }) },
    };
    const worker = createWorker();
    for (const [headers, code] of [
      [{}, "AUTH_REQUIRED"],
      [{ authorization: "Bearer fixture-device" }, "AUTH_INVALID"],
    ] as const) {
      const response = await worker.fetch(
        target.request("restore", { page: 2, ...pages[2] }, headers),
        bindings,
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(target.snapshot()).toEqual(staged);
    }
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);
