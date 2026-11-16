import { defineConnection } from "@cursor/bdk/connections";

export default defineConnection({
  agent: "pricing",
  description:
    "Delegate eBay sold prices, graded card comps, PriceCharting, and market movers to the pricing specialist.",
});
