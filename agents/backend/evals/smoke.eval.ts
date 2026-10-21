import { defineEval, includes } from "@cursor/bdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Backend agent maps modules before advising.",
  async test(t) {
    await t.send("Which module owns collection sync conflict handling?");
    t.succeeded();
    t.calledTool("api_map");
    t.check(t.reply, includes(/sync|rev|409/i));
  },
});
