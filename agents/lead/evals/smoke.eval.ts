import { defineEval, includes } from "@cursor/bdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "CTO reads the board before assigning work.",
  async test(t) {
    await t.send("Show the current SphereDex work board priorities.");
    t.succeeded();
    t.calledTool("list_board");
    t.check(t.reply, includes(/board|priorit|item|empty|backlog/i));
  },
});
