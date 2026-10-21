import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";
import {
  BOARD_KEY,
  emptyBoard,
  type BoardState,
  type Priority,
} from "../lib/board.js";

export default defineTool({
  description:
    "Record a priority conflict decision. Raises one item, optionally lowers another, and stores the rationale on both notes.",
  effect: "write",
  inputSchema: z.object({
    winnerId: z.string().min(1),
    winnerPriority: z.enum(["p0", "p1", "p2", "p3"]),
    loserId: z.string().min(1).optional(),
    loserPriority: z.enum(["p0", "p1", "p2", "p3"]).optional(),
    rationale: z.string().min(1),
  }),
  dryRunResult: ({ winnerId, winnerPriority, loserId, loserPriority, rationale }) => ({
    ok: true,
    dryRun: true,
    winnerId,
    winnerPriority,
    loserId: loserId ?? null,
    loserPriority: loserPriority ?? null,
    rationale,
  }),
  async execute(
    { winnerId, winnerPriority, loserId, loserPriority, rationale },
    ctx,
  ) {
    const board = ((await ctx.host.kv.get(BOARD_KEY)) as BoardState | null) ?? emptyBoard();
    const winner = board.items.find((item) => item.id === winnerId);
    if (!winner) {
      return { ok: false, error: `unknown winner id: ${winnerId}` };
    }
    const now = new Date().toISOString();
    const noteLine = `Conflict: ${rationale}`;
    const nextItems = board.items.map((row) => {
      if (row.id === winnerId) {
        return {
          ...row,
          priority: winnerPriority as Priority,
          notes: [row.notes, noteLine].filter(Boolean).join("\n"),
          updatedAt: now,
        };
      }
      if (loserId && row.id === loserId) {
        return {
          ...row,
          priority: (loserPriority ?? row.priority) as Priority,
          notes: [row.notes, `Deferred behind ${winnerId}: ${rationale}`]
            .filter(Boolean)
            .join("\n"),
          updatedAt: now,
        };
      }
      return row;
    });
    if (loserId && !board.items.some((item) => item.id === loserId)) {
      return { ok: false, error: `unknown loser id: ${loserId}` };
    }
    await ctx.host.kv.put(BOARD_KEY, { items: nextItems });
    return {
      ok: true,
      winnerId,
      winnerPriority,
      loserId: loserId ?? null,
      rationale,
    };
  },
});
