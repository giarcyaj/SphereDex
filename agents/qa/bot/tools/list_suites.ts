import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";

const suites = [
  { id: "carousel", command: "node tools/test_carousel.cjs", when: "Featured carousel changes." },
  { id: "scan-review", command: "node tools/test_scan_review.cjs", when: "Scan review changes." },
  { id: "editions", command: "node tools/test_editions.cjs", when: "Edition logic." },
  { id: "price-chart", command: "node tools/test_price_chart.cjs", when: "Price chart UI." },
  { id: "stock-glance", command: "node tools/test_stock_glance.cjs", when: "Sealed stock glance." },
  { id: "price-vs-rrp", command: "node tools/test_price_vs_rrp.cjs", when: "Price vs RRP." },
  { id: "tcg-news", command: "node tools/test_tcg_news.cjs", when: "TCG news feed." },
  { id: "upcoming", command: "node tools/test_upcoming_cards.cjs", when: "Upcoming cards." },
  { id: "market-index", command: "node tools/test_market_index.cjs", when: "Market index." },
  { id: "chase-check", command: "node tools/test_chase_check.cjs", when: "Chase card checks." },
  {
    id: "python-pipeline",
    command: "cd tools && python -m unittest discover -p 'test_*.py' -v",
    when: "Catalogue / rebuild pipeline.",
  },
  {
    id: "backend-types",
    command: "npx tsc --noEmit",
    when: "spheredex-backend TypeScript changes.",
  },
  {
    id: "rebuild",
    command: "python tools/rebuild.py",
    when: "After any paldeck.html edit. Required with source commit.",
  },
] as const;

export default defineTool({
  description:
    "List SphereDex test suites and when to run each. Call before writing a QA plan.",
  effect: "read",
  inputSchema: z.object({
    id: z
      .enum([
        "carousel",
        "scan-review",
        "editions",
        "price-chart",
        "stock-glance",
        "price-vs-rrp",
        "tcg-news",
        "upcoming",
        "market-index",
        "chase-check",
        "python-pipeline",
        "backend-types",
        "rebuild",
      ])
      .optional(),
  }),
  async execute({ id }) {
    return {
      suites: id ? suites.filter((s) => s.id === id) : [...suites],
      note: "Full Node guard set lives in AGENTS.md. Run feature suite first, full set before merge.",
    };
  },
});
