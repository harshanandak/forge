/** Shipped blocks are opt-in sources; registration never enables or admits one. */
export const firstPartyBlocks: Readonly<Record<string, URL>> = {
  "forge/check": new URL("../blocks/check/", import.meta.url),
  "forge/memory": new URL("../blocks/memory/", import.meta.url),
  "forge/work": new URL("../blocks/work/", import.meta.url),
};

// Source runs from <root>/src, the built package from <root>/dist/src; templates ship at <root>/templates.
const packageRoot = new URL(
  import.meta.url.endsWith(".ts") ? "../../" : "../../../",
  import.meta.url,
);

/** Shipped templates, by the name a user imports them with; importing is always explicit. */
export const firstPartyTemplates: Readonly<Record<string, URL>> = {
  delivery: new URL("templates/delivery/", packageRoot),
};
