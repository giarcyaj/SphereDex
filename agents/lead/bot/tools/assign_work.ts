import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";
import {
  BOARD_KEY,
  emptyBoard,
  type BoardState,
} from "../lib/board.js";

const ownerSchema = z.enum([
  "frontend",
  "backend",
  "pricing",
  "qa",
  "github",
  "release",
]);

export default defineTool({
  description:
    "Assign a board item to a specialist peer (frontend, backend, pricing, qa, github, release). Marks the item assigned. After calling this, ask that peer via its MCP connection.",
  effect: "write",
  inputSchema: z.object({
    id: z.string().min(1),
    owner: ownerSchema,
    brief: z
      .string()
      .min(1)
      .describe("One paragraph the specialist can act on alone."),
  }),
  dryRunResult: ({ id, owner, brief }) => ({
    ok: true,
    dryRun: true,
    id,
    owner,
    brief,
  }),
  async execute({ id, owner, brief }, ctx) {
    const board = ((await ctx.host.kv.get(BOARD_KEY)) as BoardState | null) ?? emptyBoard();
    const existing = board.items.find((item) => item.id === id);
    if (!existing) {
      return { ok: false, error: `unknown item id: ${id}` };
    }
    const item = {
      ...existing,
      owner,
      status: "assigned" as const,
      notes: brief,
      updatedAt: new Date().toISOString(),
    };
    await ctx.host.kv.put(BOARD_KEY, {
      items: board.items.map((row) => (row.id === id ? item : row)),
    });
    return {
      ok: true,
      item,
      next: `Ask the ${owner} peer with this brief. Keep routing one-way.`,
    };
  },
});
