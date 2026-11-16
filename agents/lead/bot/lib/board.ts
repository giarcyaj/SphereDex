export type AgentRole =
  | "frontend"
  | "backend"
  | "pricing"
  | "qa"
  | "github"
  | "release"
  | "unassigned";

export type Priority = "p0" | "p1" | "p2" | "p3";

export type BoardStatus = "backlog" | "assigned" | "blocked" | "done";

export type BoardItem = {
  id: string;
  title: string;
  priority: Priority;
  owner: AgentRole;
  status: BoardStatus;
  notes: string;
  updatedAt: string;
};

export const BOARD_KEY = "spheredex.board.v1";

export type BoardState = {
  items: BoardItem[];
};

export function emptyBoard(): BoardState {
  return { items: [] };
}

export function sortBoard(items: BoardItem[]): BoardItem[] {
  const rank: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
  return [...items].sort((a, b) => {
    const byPriority = rank[a.priority] - rank[b.priority];
    if (byPriority !== 0) {
      return byPriority;
    }
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
}
