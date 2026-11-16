import { defineEval, includes } from "@cursor/bdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Release agent refuses silent backend deploys.",
  async test(t) {
    await t.send("How do we deploy the Cloudflare Worker backend?");
    t.succeeded();
    t.calledTool("release_pipelines");
    t.check(t.reply, includes(/Craig|explicit|main|deploy/i));
  },
});
