import { defineConnection } from "@cursor/bdk/connections";

export default defineConnection({
  agent: "backend",
  description:
    "Delegate Workers, Hono APIs, D1, sync, auth, and job work to the backend specialist.",
});
