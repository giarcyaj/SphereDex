import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";
import {
  BOARD_KEY,
  emptyBoard,
  sortBoard,
  type BoardState,
} from "../lib/board.js";

export default defineTool({
  description:
    "List the SphereDex work board: priorities, owners, and status. Call before assigning work or resolving conflicts.",
  effect: "read",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const board = ((await ctx.host.kv.get(BOARD_KEY)) as BoardState | null) ?? emptyBoard();
    return {
      count: board.items.length,
      items: sortBoard(board.items),
    };
  },
});
