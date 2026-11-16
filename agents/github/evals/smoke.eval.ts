import { defineEval, includes } from "@cursor/bdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "GitHub agent loads the app PR checklist.",
  async test(t) {
    await t.send("What must be true before merging an app PR?");
    t.succeeded();
    t.calledTool("pr_checklist");
    t.check(t.reply, includes(/rebuild|bundle|paldeck/i));
  },
});
