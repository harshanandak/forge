import { ForgeFailure } from "./failure.ts";

export class SkillCatalogLimit extends ForgeFailure {
  constructor(limit: "bytes" | "entries", max: number) {
    super({
      code: "LIMIT_EXCEEDED",
      message: `Skill resource catalog exceeds ${max} ${limit}.`,
      expected: { limit, max },
      retry: "never",
    });
  }
}
