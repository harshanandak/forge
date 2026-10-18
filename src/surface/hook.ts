import type { SurfaceCatalog } from "./catalog.ts";
import { dispatch, type CallOptions } from "./dispatch.ts";
import { failure, respond, type SurfaceResponse } from "./result.ts";

/** The host supplies the event's JSON input; operation selection remains catalog-driven. */
export async function runHook(
  catalog: SurfaceCatalog,
  op: string,
  input: AsyncIterable<Uint8Array>,
  options: Omit<CallOptions, "caller"> = {},
  maxBytes = 1_048_576,
): Promise<SurfaceResponse> {
  try {
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of input) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes)
        return respond(
          failure("LIMIT_EXCEEDED", `Hook stdin exceeds ${maxBytes} bytes.`),
        );
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    return respond(
      await dispatch(catalog, op, value, { ...options, caller: "agent" }),
    );
  } catch {
    return respond(
      failure("INPUT_INVALID", "Hook stdin must contain one JSON value."),
    );
  }
}
