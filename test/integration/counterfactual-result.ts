export function assertCounterfactualResult(
  result: {
    status: number | null;
    error?: Error | undefined;
    stdout: string | null;
    stderr: string | null;
  },
  mutation: string,
): void {
  if (
    result.status === null ||
    (result.error &&
      "code" in result.error &&
      result.error.code === "ETIMEDOUT") ||
    !`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  )
    throw new Error(
      `Counterfactual infrastructure stall: ${mutation} (status ${result.status}, ${result.error?.message ?? "no child error"})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  if (result.status === 0)
    throw new Error(
      `Counterfactual survived: ${mutation}\n${result.stdout}\n${result.stderr}`,
    );
}
