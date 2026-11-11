// Whether a project's authority is Forge cloud, from the committed binding and the project manifest.
// Read only: no binding or credential is written and no token is looked up. An unsafe binding, one
// that disagrees with the manifest, or a saved credential with no binding is refused.
import { ForgeFailure } from "../contract/failure.ts";
import {
  credentialStore,
  openCloudFiles,
  readBinding,
} from "./cloud-profile.ts";
import { readProjectManifest } from "./project-manifest.ts";
import { projectManifestRoot } from "./providers.ts";

export type CloudBindingState =
  | { readonly kind: "unbound" }
  | {
      readonly kind: "bound";
      readonly identity: string;
      readonly origin: string;
      readonly project: string;
    };

const refuse = (code: string, message: string) =>
  new ForgeFailure({ code, message, retry: "never" });

export function cloudBinding(
  root: string,
  home: string | undefined,
): CloudBindingState {
  const base = projectManifestRoot(root);
  const binding = readBinding(base);
  const manifest = readProjectManifest(base);
  if (binding !== undefined) {
    if (manifest === undefined)
      throw refuse(
        "CONTEXT_MISSING",
        ".forge/cloud.json binds this project but .forge/project.json is missing",
      );
    if (binding.identity !== manifest.id)
      throw refuse(
        "INPUT_CONFLICT",
        ".forge/cloud.json belongs to a different project identity",
      );
    const { identity, origin, project } = binding;
    return { kind: "bound", identity, origin, project };
  }
  if (manifest === undefined || home === undefined || home === "")
    return { kind: "unbound" };
  const known = credentialStore(openCloudFiles(home)).associations(manifest.id);
  if (known.length === 0) return { kind: "unbound" };
  throw refuse(
    "INPUT_CONFLICT",
    `${known.length > 1 ? "Saved cloud credentials name different servers or projects" : "This project has a saved cloud credential but no .forge/cloud.json"}; run forge cloud login again`,
  );
}
