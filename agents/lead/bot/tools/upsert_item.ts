import { defineTool } from "@cursor/bdk/tools";
import * as z from "zod/v4";
import {
  BOARD_KEY,
  emptyBoard,
  type BoardItem,
  type BoardState,
} from "../lib/board.js";

const prioritySchema = z.enum(["p0", "p1", "p2", "p3"]);
const ownerSchema = z.enum([
  "frontend",
  "backend",
  "pricing",
  "qa",
  "github",
  "release",
  "unassigned",
]);
const statusSchema = z.enum(["backlog", "assigned", "blocked", "done"]);

export default defineTool({
  description:
    "Create or update a work item on the SphereDex board. Use for planning and priority changes. Prefer assign_work when handing a backlog item to a specialist.",
  effect: "write",
  inputSchema: z.object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe("Existing item id. Omit to create a new item."),
    title: z.string().min(1),
    priority: prioritySchema.default("p2"),
    owner: ownerSchema.default("unassigned"),
    status: statusSchema.default("backlog"),
    notes: z.string().default(""),
  }),
  dryRunResult: ({ id, title, priority, owner, status }) => ({
    ok: true,
    dryRun: true,
    item: {
      id: id ?? "new",
      title,
      priority,
      owner,
      status,
      notes: "",
      updatedAt: new Date(0).toISOString(),
    },
  }),
  async execute({ id, title, priority, owner, status, notes }, ctx) {
    const board = ((await ctx.host.kv.get(BOARD_KEY)) as BoardState | null) ?? emptyBoard();
    const now = new Date().toISOString();
    const existing = id ? board.items.find((item) => item.id === id) : undefined;
    const item: BoardItem = {
      id: existing?.id ?? id ?? `item-${Date.now().toString(36)}`,
      title,
      priority,
      owner,
      status,
      notes,
      updatedAt: now,
    };
    const items = existing
      ? board.items.map((row) => (row.id === existing.id ? item : row))
      : [...board.items, item];
    await ctx.host.kv.put(BOARD_KEY, { items });
    return { ok: true, item };
  },
});
