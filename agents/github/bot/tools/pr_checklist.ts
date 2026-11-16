import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";

export default defineTool({
  description:
    "Return the SphereDex PR review checklist for the app or backend repo.",
  effect: "read",
  inputSchema: z.object({
    repo: z.enum(["spheredex", "spheredex-backend"]),
  }),
  async execute({ repo }) {
    if (repo === "spheredex-backend") {
      return {
        repo,
        checks: [
          "Additive API fields only when possible.",
          "New migration file if schema changes; never edit applied ones.",
          "ALLOW_ORIGIN stays *.",
          "No deploy / migrate:remote / JWT_SECRET rotation in the PR notes unless Craig asked.",
          "README endpoint table updated when routes change.",
          "npx tsc --noEmit clean.",
        ],
      };
    }
    return {
      repo,
      checks: [
        "src/paldeck.html edited when UI/logic changed.",
        "python tools/rebuild.py output committed with source.",
        "No hand edits to docs/app, Android assets HTML, or iOS spheredex.html.",
        "Guard suites for touched features pass.",
        "Catalogue bump + make_native_catalog if cards changed.",
        "No dashes in user-facing copy.",
        "Privacy-sensitive changes flagged for store disclosure.",
      ],
    };
  },
});
