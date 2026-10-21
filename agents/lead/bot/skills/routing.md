---
description: When to call which SphereDex peer and when to launch a cloud agent.
---

# Routing

1. Classify the request: plan, implement, review, price, test, or ship.
2. Update the board (`list_board`, `upsert_item`) when the work is more than
   a one-line answer.
3. Ask the matching peer. Do not fan out to every peer.
4. Launch a cloud agent only when a checkout and PR are required, and only
   after approval is available (`needsApproval` is on).
5. Summarize peer answers for the human. Do not re-solve their specialty.

Conflicts: call `resolve_conflict`, then re-assign. Never leave two peers
owning the same file without a written winner.
