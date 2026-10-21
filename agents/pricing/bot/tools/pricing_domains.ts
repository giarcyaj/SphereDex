import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";

const domains = [
  {
    id: "ebay-sold",
    sources: ["eBay Browse / sold comps"],
    backend: ["prices", "history", "movers"],
    notes: "Raw and condition-sensitive sold prices.",
  },
  {
    id: "graded",
    sources: ["eBay graded listings", "PriceCharting"],
    backend: ["prices", "alerts"],
    notes: "PSA / CGC / TAG slabs. Grade and cert matter.",
  },
  {
    id: "sealed",
    sources: ["stock glance", "retail feeds"],
    backend: ["stock", "releases"],
    notes: "Boxes and ETBs. Not single-card sold comps.",
  },
  {
    id: "rrp",
    sources: ["publisher RRP", "price vs RRP UI"],
    backend: ["prices"],
    notes: "Compare market to recommended retail, not sold history alone.",
  },
] as const;

export default defineTool({
  description:
    "List SphereDex pricing domains and which backend modules own them.",
  effect: "read",
  inputSchema: z.object({
    id: z.enum(["ebay-sold", "graded", "sealed", "rrp"]).optional(),
  }),
  async execute({ id }) {
    return {
      domains: id ? domains.filter((d) => d.id === id) : [...domains],
      rules: [
        "Never invent sold prices.",
        "Never print pricing API secrets.",
        "Separate sold comps, asks, and RRP.",
      ],
    };
  },
});
