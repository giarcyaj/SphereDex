---
description: Production safety rules for the SphereDex Workers backend.
---

# Workers safety

- Live users are signed in. Prefer additive API fields.
- New D1 changes = new migration file with the next number.
- Secrets stay in `wrangler secret`. Never print values.
- Sync conflict semantics (`409` + `rev` + `blob`) are load-bearing.
- Type-check with `npx tsc --noEmit` after edits.
