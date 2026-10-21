import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";

const modules = [
  { id: "auth", path: "src/auth.ts", notes: "Accounts, sessions, PBKDF2." },
  { id: "sync", path: "src/index.ts", notes: "PUT/GET /api/state with rev." },
  { id: "prices", path: "src/prices.ts", notes: "Price ingest and lookups." },
  { id: "history", path: "src/history.ts", notes: "Price history series." },
  { id: "movers", path: "src/movers.ts", notes: "Market movers." },
  { id: "alerts", path: "src/alerts.ts", notes: "Price alerts." },
  { id: "graded", path: "src/graded.ts", notes: "Graded card pricing paths." },
  { id: "push", path: "src/push.ts", notes: "FCM push." },
  { id: "apns", path: "src/apns.ts", notes: "Apple push." },
  { id: "digest", path: "src/digest.ts", notes: "Email digests." },
  { id: "email", path: "src/email.ts", notes: "Resend outbound mail." },
  { id: "stock", path: "src/stock.ts", notes: "Sealed stock glance." },
  { id: "wishlist", path: "src/wishlist.ts", notes: "Wishlist sync helpers." },
  { id: "releases", path: "src/releases.ts", notes: "Release calendar." },
  { id: "cards", path: "src/cards.ts", notes: "Card catalogue APIs." },
  { id: "tcgcsv", path: "src/tcgcsv.ts", notes: "TCGCSV ingest." },
  { id: "discovery", path: "src/discovery.ts", notes: "Discovery feeds." },
  { id: "meta", path: "src/meta.ts", notes: "Health / meta endpoints." },
] as const;

export default defineTool({
  description:
    "Map SphereDex backend feature modules to source paths. Call before proposing API or job changes.",
  effect: "read",
  inputSchema: z.object({
    id: z
      .enum([
        "auth",
        "sync",
        "prices",
        "history",
        "movers",
        "alerts",
        "graded",
        "push",
        "apns",
        "digest",
        "email",
        "stock",
        "wishlist",
        "releases",
        "cards",
        "tcgcsv",
        "discovery",
        "meta",
      ])
      .optional(),
  }),
  async execute({ id }) {
    return {
      repo: "giarcyaj/spheredex-backend",
      entry: "src/index.ts",
      modules: id ? modules.filter((m) => m.id === id) : [...modules],
      gates: [
        "Never deploy or migrate:remote without Craig.",
        "Never edit applied migrations.",
        "Keep ALLOW_ORIGIN as *.",
      ],
    };
  },
});
