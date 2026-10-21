# spheredex-lead

Lead / CTO agent for the SphereDex team. Sibling projects under `../`
are peer specialists (`frontend`, `backend`, `pricing`, `qa`, `github`,
`release`). Serve them together with `bdk dev ..` from this folder's
parent.

## Loop

```bash
npx --yes "@cursor/bdk@0.2.27" validate --dir .
npx --yes "@cursor/bdk@0.2.27" info --dir . --json
npx --yes "@cursor/bdk@0.2.27" call list_board --dir . --input '{}'
npx --yes "@cursor/bdk@0.2.27" eval --dir . --list
npm run check
```

Run under Node, never Bun. Peer connections resolve only in multi-agent
serve (`bdk dev ..`). Single-agent serve omits peers with a warning.
