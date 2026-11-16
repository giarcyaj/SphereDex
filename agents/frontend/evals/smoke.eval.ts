import { defineEval, includes } from "@cursor/bdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Frontend agent maps UI surfaces before advising.",
  async test(t) {
    await t.send("Where does the featured carousel live?");
    t.succeeded();
    t.calledTool("app_surface");
    t.check(t.reply, includes(/carousel|paldeck|FEATURED/i));
  },
});
