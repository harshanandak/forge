// Run by cloud-device-mismatch.test.ts in its own process, where the cloud client modules refuse to load.
// A bound project asked about another machine's device must be refused without loading them.
import { writeFileSync } from "node:fs";

Bun.plugin({
  name: "refuse-cloud-client",
  setup(build) {
    build.onLoad(
      { filter: /(cloud-login|cloud-state-client|http[/\\]index)\.ts$/ },
      ({ path }) => {
        throw new Error(`cloud module loaded: ${path}`);
      },
    );
  },
});
const fx = await import("../cloud-fixture.ts");
const { selectCloud } =
  await import("../../../src/assembly/cloud-authority.ts");
const { credentialStore, openCloudFiles } =
  await import("../../../src/assembly/cloud-profile.ts");

const s = fx.sandbox();
try {
  writeFileSync(s.binding, `${JSON.stringify(fx.bindingFor())}\n`);
  await credentialStore(openCloudFiles(s.home)).save(fx.entry(Date.now()));
  const runtime = {
    preflight: (request: unknown, accepted: (value: unknown) => void) => {
      accepted(request);
      return {
        block: { manifest: { id: "forge/work" } },
        operation: { declaredOp: "issue.show" },
        context: {},
      };
    },
  };
  const request = {
    requestId: "r-1",
    op: "issue.show",
    input: { id: "forge-1" },
    context: { device: { id: "dev-1" } },
  };
  const outcome = await selectCloud(
    {
      root: s.root,
      deviceRoot: s.deviceRoot,
      scope: () => {},
      env: { HOME: s.home, FORGE_DEVICE_ID: "other-device" },
    },
    runtime as never,
    request as never,
  ).then(
    () => ({ refused: false }),
    (error: { error?: { code?: string; message?: string } }) => ({
      refused: true,
      code: error.error?.code,
      message: error.error?.message,
    }),
  );
  console.log(JSON.stringify(outcome));
} finally {
  s.close();
}
