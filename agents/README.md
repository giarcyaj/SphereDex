# SphereDex agent team

BDK multi-agent workspace for SphereDex. A Lead / CTO agent plans work and
delegates to six specialists that share the app and backend GitHub repos.

```text
lead  ──►  frontend   UI, layouts, animations (src/paldeck.html)
       ├─► backend    APIs, jobs, D1 (spheredex-backend)
       ├─► pricing    eBay, sold prices, graded cards
       ├─► qa         testing and bug fixes
       ├─► github     PRs, reviews, merging
       └─► release    builds and deployments
              │
              ▼
     Shared GitHub → CI → merge → deploy pipeline
```

## Defaults used for this scaffold

AskQuestion was unavailable, so these defaults were locked in:

- Purpose: repo automation and domain orchestration for SphereDex
- Model: `grok-4.5` with `effort=high`, `fast=true`
- Channels: playground + HTTP on every agent; GitHub events on `github`
- MCP: peer connections from `lead` to each specialist; no external MCP yet
- Capabilities: server tools, skills, peer agents, smoke evals

## Run the team locally

```bash
# from this folder (mounts every child project)
npx --yes "@cursor/bdk@0.2.27" dev .

# talk to the CTO
npx --yes "@cursor/bdk@0.2.27" chat --url http://127.0.0.1:3000/lead \
  --message "Prioritize a sealed stock glance bug on Android WebView"

# talk to one specialist
npx --yes "@cursor/bdk@0.2.27" chat --url http://127.0.0.1:3000/frontend \
  --message "Where do carousel styles live?"
```

Each project also runs alone:

```bash
npx --yes "@cursor/bdk@0.2.27" validate --dir ./lead
npx --yes "@cursor/bdk@0.2.27" call list_board --dir ./lead --input '{}'
npm --prefix ./lead run check
```

## Hard rules (all agents)

- Edit `src/paldeck.html`, then `python tools/rebuild.py`. Never hand-edit
  generated bundles under `docs/app/`, Android assets, or iOS resources.
- No dashes in user-facing copy.
- Never commit or print secrets.
- Backend deploy, remote migrate, and push to `main` only when Craig
  explicitly asks. The release agent refuses otherwise.
- Credit Pocketpair / Bushiroad. Never imply the app is official.

## GitHub events

`github/bot/lib/config.ts` starts with `repos: []` so local `call` / `eval` /
`dev` boot without a Cursor login. Before streaming PR events, set:

```ts
repos: ["giarcyaj/spheredex", "giarcyaj/spheredex-backend"]
```

Then `bdk login` and serve with `--cursor-events --repo giarcyaj/spheredex
--repo giarcyaj/spheredex-backend` as needed.

## Deploy

Each directory is its own BDK project. Deploy peers with matching slugs
(`lead`, `frontend`, `backend`, `pricing`, `qa`, `github`, `release`) so
the lead's peer connections resolve on Cursor-managed hosting.

Lead peer connections only resolve in multi-agent serve
(`bdk dev ./agents`). A single-agent `call --dir ./lead` fails on unknown
peers; use `bdk dev .` from this folder instead.
