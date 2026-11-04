import { expect, setDefaultTimeout, test } from "bun:test";
import { assertCounterfactualResult } from "../integration/counterfactual-result.ts";

setDefaultTimeout(1000);
const failure = { status: 1, stdout: "", stderr: "expected assertion" };
test.each([
  { ...failure, status: null },
  {
    ...failure,
    error: Object.assign(new Error("deadline"), { code: "ETIMEDOUT" }),
  },
  { ...failure, stderr: "" },
  { ...failure, stdout: " \n", stderr: "\t" },
  { ...failure, status: 0, stderr: "" },
])("counterfactual infrastructure stall names the mutation: %j", (result) => {
  expect(() =>
    assertCounterfactualResult(result, "remove lease check"),
  ).toThrow("Counterfactual infrastructure stall: remove lease check");
});
test("a real counterfactual survival stays survival; assertion failure stays valid", () => {
  expect(() =>
    assertCounterfactualResult({ ...failure, status: 0 }, "lease"),
  ).toThrow("Counterfactual survived: lease");
  expect(() => assertCounterfactualResult(failure, "lease")).not.toThrow();
});
