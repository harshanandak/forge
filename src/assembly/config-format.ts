import { isObject, type JsonObject } from "../core/config/pointer.ts";
import type { ConfigEnvironment } from "../core/config/config.ts";

/** Describe the retired document without accepting it or inventing replacement settings. */
export function describeConfigFormat(
  document: JsonObject,
): ReturnType<NonNullable<ConfigEnvironment["describeFormat"]>> {
  if (
    !isObject(document.template) ||
    document.template.kind !== "forge.adoptionTemplate"
  )
    return undefined;
  return {
    name: "adoption-template (forge.adoptionTemplate)",
    fields: {
      template:
        "templates now records provenance as [{template, digest}]; the old metadata has no current equivalent and supplies no digest, so do not rename it or invent provenance",
      workflow:
        "phases and gates have no current equivalent in the composition document; choose template skills and block config that enforce the intended behavior",
      adapters:
        "blocks now selects implementations with source, enabled and config; primary, mirrors and targets have no current equivalent, so choose each block source explicitly",
      protectedPaths:
        "protectedPaths has no current equivalent; arrange equivalent path protection outside this composition document before replacing the setting",
    },
  };
}
