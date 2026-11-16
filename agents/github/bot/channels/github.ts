import { defaultGitHubAuth, githubChannel } from "@cursor/bdk/channels/github";
import config from "../lib/config.js";

const REVIEW_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

export default githubChannel({
  botName: "spheredex-github",
  // Empty repos skips the Cursor GitHub binding so local call / eval / dev boot.
  cursorAccount:
    config.repos.length > 0
      ? { repos: config.repos, permissions: "pr-write" }
      : undefined,

  onPullRequest: (ctx, pr) => {
    if (!REVIEW_ACTIONS.has(pr.action) || pr.draft || pr.merged) {
      return null;
    }
    return {
      auth: defaultGitHubAuth(ctx),
      text: [
        `Review SphereDex PR ${ctx.repository.fullName}#${pr.number}: ${pr.title}.`,
        "Call pr_checklist for the matching repo first.",
        "Summarize merge readiness in under eight lines.",
      ].join(" "),
    };
  },
});
