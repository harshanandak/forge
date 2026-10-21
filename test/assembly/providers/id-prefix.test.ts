import { expect, setDefaultTimeout, test } from "bun:test";
import { idPrefix } from "../../../src/assembly/providers.ts";

setDefaultTimeout(30_000);

test("a project name becomes an id prefix of lowercase letters, digits and single hyphens", () => {
  expect(idPrefix("forge")).toBe("forge");
  expect(idPrefix("Product-Suite")).toBe("product-suite");
  expect(idPrefix("My_Repo.v2")).toBe("my-repo-v2");
  expect(idPrefix("--scoreeasy--")).toBe("scoreeasy");
  expect(idPrefix("x".repeat(40))).toBe("x".repeat(32));
  expect(idPrefix("___")).toBeUndefined();
});
