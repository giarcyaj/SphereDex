import { defineConnection } from "@cursor/bdk/connections";

export default defineConnection({
  agent: "github",
  description:
    "Delegate PR review, CI triage, and merge readiness to the GitHub specialist.",
});
