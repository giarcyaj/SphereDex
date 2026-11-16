import { defineEval, includes } from "@cursor/bdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "QA agent lists suites before planning tests.",
  async test(t) {
    await t.send("Which tests should run after a carousel change?");
    t.succeeded();
    t.calledTool("list_suites");
    t.check(t.reply, includes(/carousel|test_carousel/i));
  },
});
