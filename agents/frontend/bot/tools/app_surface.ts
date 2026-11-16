import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";

const surfaces = [
  {
    id: "home",
    path: "src/paldeck.html",
    notes: "Home feed, featured carousel (fenced FEATURED CAROUSEL).",
  },
  {
    id: "collection",
    path: "src/paldeck.html",
    notes: "Collection grid; wishlist / favourites / graded are modes.",
  },
  {
    id: "scan-review",
    path: "src/paldeck.html",
    notes: "Scan review UI (fenced SCAN REVIEW). Native scanners feed it.",
  },
  {
    id: "market",
    path: "src/paldeck.html",
    notes: "Prices, movers, charts. Backend feeds live numbers.",
  },
  {
    id: "nav",
    path: "src/paldeck.html",
    notes: "Floating bottom bar + More sheet. Legacy tab chips still route.",
  },
] as const;

export default defineTool({
  description:
    "List SphereDex UI surfaces and where they live in the canonical app file.",
  effect: "read",
  inputSchema: z.object({
    id: z
      .enum(["home", "collection", "scan-review", "market", "nav"])
      .optional()
      .describe("Optional surface id to filter."),
  }),
  async execute({ id }) {
    const list = id ? surfaces.filter((s) => s.id === id) : [...surfaces];
    return {
      canonical: "src/paldeck.html",
      rebuild: "python tools/rebuild.py",
      surfaces: list,
    };
  },
});
