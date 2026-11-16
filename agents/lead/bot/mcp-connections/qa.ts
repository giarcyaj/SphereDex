import { defineConnection } from "@cursor/bdk/connections";

export default defineConnection({
  agent: "qa",
  description:
    "Delegate testing, guard suites, bug reproduction, and fix verification to the QA specialist.",
});
