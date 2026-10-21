import cursorCloudAgents from "@cursor/bdk/extensions/cursor-cloud-agents";

export default cursorCloudAgents({
  needsApproval: true,
  cloud: {
    repos: [
      {
        url: "https://github.com/giarcyaj/spheredex",
        startingRef: "main",
      },
      {
        url: "https://github.com/giarcyaj/spheredex-backend",
        startingRef: "main",
      },
    ],
    autoCreatePR: true,
  },
});
