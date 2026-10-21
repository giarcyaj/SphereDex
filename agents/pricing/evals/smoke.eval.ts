import { defineEval, includes } from "@cursor/bdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Pricing agent picks a domain before advising.",
  async test(t) {
    await t.send("How should we think about PSA 10 sold comps?");
    t.succeeded();
    t.calledTool("pricing_domains");
    t.check(t.reply, includes(/graded|PSA|PriceCharting|sold/i));
  },
});
