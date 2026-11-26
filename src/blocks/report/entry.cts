import type { ReportInput, ReportServices } from "./types.ts";

const { recordOccurrence } =
  require("./store.ts") as typeof import("./store.ts");

module.exports = {
  "report.create": (call: { input: ReportInput; services: ReportServices }) =>
    recordOccurrence(call.input, call.services),
};
