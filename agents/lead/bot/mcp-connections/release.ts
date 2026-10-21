import { defineConnection } from "@cursor/bdk/connections";

export default defineConnection({
  agent: "release",
  description:
    "Delegate build and deployment process questions to the release specialist. Production deploys stay gated.",
});
