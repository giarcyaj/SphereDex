import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";

const pipelines = [
  {
    id: "web",
    repo: "giarcyaj/spheredex",
    path: "docs/app/",
    notes: "PWA on GitHub Pages. Requires rebuild.py output committed.",
    humanGate: "Merge to main after green CI.",
  },
  {
    id: "android",
    repo: "giarcyaj/spheredex",
    path: ".github/workflows/build-apk.yml",
    notes: "APK build after tests.yml. No Gradle wrapper; CI installs Gradle.",
    humanGate: "Green tests.yml then build-apk.yml.",
  },
  {
    id: "ios",
    repo: "giarcyaj/spheredex",
    path: "ios/SphereDex/",
    notes: "XcodeGen project.yml. WKWebView loads spheredex.html.",
    humanGate: "Human Xcode / TestFlight step.",
  },
  {
    id: "backend",
    repo: "giarcyaj/spheredex-backend",
    path: ".github/workflows/deploy.yml",
    notes: "Push to main migrates remote D1 then deploys Worker.",
    humanGate: "Craig must explicitly ask before pushing main / deploy.",
  },
] as const;

export default defineTool({
  description:
    "List SphereDex release pipelines and their human gates. Call before advising a ship.",
  effect: "read",
  inputSchema: z.object({
    id: z.enum(["web", "android", "ios", "backend"]).optional(),
  }),
  async execute({ id }) {
    return {
      pipelines: id ? pipelines.filter((p) => p.id === id) : [...pipelines],
      refuseWithoutCraig: [
        "backend deploy",
        "migrate:remote",
        "push backend main",
        "JWT_SECRET rotation",
      ],
    };
  },
});
