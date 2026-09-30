# Secrets — moving `SIEVE_API_KEY` off the disk and into Infisical

Today the one secret this project needs sits in a plaintext `android/.env` on your
machine: `SIEVE_API_KEY`, the sieve scrape key used by the server-side tooling in
`tools/`. A file on one laptop is the whole store — it does not follow you to another
machine, it cannot be rotated without editing a file, and it has no audit trail.

The goal is to keep the key in [Infisical](https://app.infisical.com) and hand it to the
tooling at run time as an environment variable. Nothing in this repo has to change for
that: `tools/sieve.py` already reads `os.environ["SIEVE_API_KEY"]` **before** it falls
back to `.env`, so wrapping the command is the entire change.

## What is actually secret here

| Name | Read by | Where it lives today |
| --- | --- | --- |
| `SIEVE_API_KEY` | `tools/sieve.py`, `tools/sieve_run.py` | `android/.env` (gitignored) |
| `SIEVE_BASE_URL` | `tools/sieve.py` | unset — defaults to the production host |
| `X_BEARER_TOKEN` | `tools/fetch_x_posts.py` (Sieve refresh workflow) | Infisical `dev` only — see [X API token](#x-api-token) |
| `XAI_API_KEY` | `tools/translate_posts.py` (Sieve refresh workflow) | Infisical `dev` only, optional — see [xAI API key](#xai-api-key-english-headlines-for-the-japanese-account) |
| `X_USER_ID` | `tools/fetch_x_posts.py` | optional, Infisical `dev` — not secret, saves a lookup call per run |
| `KEYSTORE_*`, `KEY_ALIAS`, `GOOGLE_SERVICES_JSON_BASE64` | `.github/workflows/*.yml` | GitHub's encrypted repo secrets, never a file |

Only the first row is on your disk. The Android signing and Firebase secrets in row
three already live in GitHub's secret store, so there is nothing to migrate for them —
see [CI, staging and production](#ci-staging-and-production) if you would rather they
came from Infisical too.

The key is account-wide with no scopes, so it must never reach a built page, the
Android or iOS bundle, a log line, an error report, or `stage/` output. `.env` stays
gitignored; `.env.example` stays tracked and stays empty.

## One-time setup

### 1. Create the project and put the key in it

1. Sign in (or sign up) at <https://app.infisical.com>.
2. **Secrets Management → + Add New Project**, and name it after the service —
   `spheredex` is the obvious choice.
3. Every new project starts with three environments: **Development**, **Staging**,
   **Production**. Their slugs are `dev`, `staging` and `prod`, which is what the CLI's
   `--env` flag takes.
4. Add the key. The fastest route is the one you already have: open the Development
   environment and **drag `android/.env` onto the Secrets Overview page**. Infisical
   parses the file, shows you what it found, and lets you pick the target environments
   before uploading. Afterwards the local file is a copy, not the source.

If you would rather not drag a key file around, run
`python tools/sieve_run.py login` (device login) or create a key under sieve's
**Settings → API keys**, then paste the value into Infisical by hand and delete the
local file. `tools/sieve_run.py doctor` tells you which of the two you ended up with.

> Don't have a key at all yet? `python tools/sieve_run.py login` walks the device-code
> flow and writes one. Use that as the bootstrap, import it, then delete it.

### 2. Install the CLI and log in

Pick your package manager:

```powershell
winget install infisical            # Windows
```

```bash
brew install infisical/get-cli/infisical      # macOS
npm install -g @infisical/cli                 # any platform with Node
```

Then authenticate:

```bash
infisical login
```

The prompt asks which instance to use and finishes in the browser. On a machine with no
browser — a remote SSH session, WSL 2, Codespaces — use `infisical login -i` and log in
from the terminal instead.

### 3. Link the codebase

Run this from `android/`, which is the codebase that holds the tooling (it is its own
git repository; the outer workspace folder ignores it):

```bash
cd android
infisical init
```

Pick your organization and project. This writes `android/.infisical.json`, which holds
only local project settings — a project ID and the default environment slug. It contains
no secret values, so it **is** safe to commit, and once it exists the commands below no
longer need a project ID.

### 4. Prove it works

There are three states you can be in, and `doctor` exists to tell them apart. It prints
the key's **length**, never the key:

```bash
python tools/sieve_run.py doctor
```

- `from the environment (49 chars) — injected, not on disk` — you are done.
- `from …/.env (49 chars) — still a file on this machine` — nothing has changed yet; the
  run works but the key is still on disk.
- `missing` — nothing supplies it, and the command exits non-zero.

Run each command through the CLI so the key arrives via the environment:

```bash
infisical run --env=dev -- python tools/sieve_run.py doctor
```

Then do the decisive test. Rename the local file away and confirm the tooling still
works — if it does, the key is genuinely coming from Infisical:

```powershell
Move-Item android/.env android/.env.backup
infisical run --env=dev -- python tools/sieve_run.py run "Extract the text and author of each quote" --url https://quotes.toscrape.com --fields quote,author --shape long
```

`Move-Item .env.backup .env` puts it back. Delete the backup once you are satisfied
(don't delete it before — that is your way back if something is wrong).

## Daily use

Wrap the command. `--` separates the CLI's own flags from yours:

```bash
infisical run --env=dev -- python tools/sieve_run.py run "Extract ..." --url https://example.com
infisical run --env=dev -- python tools/sieve_run.py status <session_id>
```

Add `--watch` while you are working and the command restarts whenever a secret changes
in Infisical:

```bash
infisical run --watch --env=dev -- python tools/sieve_run.py doctor
```

`--env` defaults to the `defaultEnvironment` recorded in `.infisical.json`, so plain
`infisical run -- <command>` usually works too; naming it is clearer in a shared doc.

Two things make the migration stick for the whole team rather than just for you:

- `sieve_run.py doctor` reports the source, so "which one answered?" is never a guess.
- Every other command **warns on stderr** when it had to fall back to `.env`. A
  half-finished migration still runs, but it cannot pass for a finished one.

## X API token

The Home carousel and News feed show @PalworldOCG_EN posts. x.com's robots.txt is
`Disallow: /`, so Sieve refuses to scrape it; the official X API v2 is the only
sanctioned source. `.github/workflows/sieve-refresh.yml` runs `tools/fetch_x_posts.py`
through `infisical run`, and the tool skips cleanly (the run still publishes official
news) until the token exists.

1. Create an app in the X developer console (<https://console.x.com>) and generate its
   **Bearer Token** (app-only auth; read access is enough). The API is billed per use:
   the workflow reads at most 10 posts twice a day, plus one username lookup per run
   unless `X_USER_ID` is set.
2. In Infisical, open the project's **Development** environment and add
   `X_BEARER_TOKEN` with that value. Paste it into Infisical directly; never put it in
   `.env`, a workflow file or a GitHub secret.
3. Optional: add `X_USER_ID` (the numeric id of @PalworldOCG_EN). The first run with a
   token looks it up, and you can copy it from any `/2/users/by/username/PalworldOCG_EN`
   response.
4. Check it locally without printing the value:

```bash
infisical run --env=dev -- python tools/fetch_x_posts.py --root stage/sieve-x-check --print
```

Rotate the token from the developer console if it ever reaches a log or a file.

## xAI API key (English headlines for the Japanese account)

`tools/fetch_x_posts.py` follows both official accounts, and @PalworldOCG posts in
Japanese. `tools/translate_posts.py` turns those headlines into English so the feed does
not show Japanese text to an English reader. It translates the headline only: every post
is already fetched through the official X API, so nothing here can invent a post.

Everything about this is optional. Without the key the Japanese posts publish in their
original form, which is exactly what happens today, and the step says so rather than
failing.

1. Create a key in the xAI console (<https://console.x.ai>). It is billed per token; the
   work is about 1.4k tokens for ten posts, and results are cached by post link so the
   same post is never translated twice.
2. In Infisical, open the project's **Development** environment and add `XAI_API_KEY`
   with that value. Paste it into the dashboard rather than the CLI: `infisical secrets
   set` would put the key in your shell history. Never put it in `.env`, a workflow file
   or a GitHub secret.
3. Optional: add `XAI_MODEL` to pin a model. The default is `grok-4.6`.
4. No workflow change is needed. The X step already runs under `infisical run`, so the
   key is injected the moment it exists.
5. Check it locally without printing the value:

```bash
infisical run --env=dev -- python tools/fetch_x_posts.py --root stage/sieve-x-check
```

   The run reports `translated N headline(s), M from cache, K left in the original`. Any
   post it could not translate keeps its Japanese title, and `title_original` carries the
   original either way.

The cache lives at `stage/sieve/translations.json` and is carried between CI runs by
`actions/cache`. Deleting it costs one round of translation, nothing more.

Rotate the key from the xAI console if it ever reaches a log or a file.

## CI, staging and production

Never use interactive login outside your own machine. Create a machine identity and give
it Universal Auth credentials:

1. **Access Control → Machine Identities → Create**, name it, and give it an organization
   role.
2. Add it to the project (**project → Access Control → Machine Identities → Add Machine
   Identity to Project**) with a role scoped to the environments it needs — Development
   read-only is enough for a build job. Nothing here needs Production.
3. Under the identity's **Universal Auth** method, copy the non-sensitive **Client ID**
   and create a **Client Secret**.
4. Store the client ID and client secret in the platform's own secret store — GitHub
   Actions secrets, your CI provider's variables, a Kubernetes Secret, your cloud's
   secret manager. Never in the repository, and never in a workflow file.
5. Authenticate non-interactively and run:

```bash
export INFISICAL_TOKEN=$(infisical login --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" --client-secret="$INFISICAL_CLIENT_SECRET" \
    --silent --plain)
infisical run --projectId=<project-id> --env=prod -- python tools/sieve_run.py ...
```

`--silent --plain` makes the token the only thing on stdout, so it can be assigned
directly. `--projectId` is required when a machine identity is authenticating.

Two details that bite in CI:

- **Domain.** Without an interactive login nothing knows which instance you meant. Set
  `INFISICAL_DOMAIN` (or `--domain`) for EU Cloud or a self-hosted instance; the default
  is US Cloud. `.infisical.json` can pin it too, but the CLI will warn, since every
  request and credential then goes to that host.
- **Short-lived tokens.** A Universal Auth access token has a TTL (two hours by default,
  configurable). Exchange it at the start of the job, as above. If you need long-lived
  automated access, use an access token *period* so the workload can renew the token
  itself instead of holding a long-lived client secret.

Kubernetes is a different mechanism — the Infisical **Kubernetes Operator** injects
secrets into workloads, so there is a chart and CRDs rather than an `infisical run`
prefix. See the delivery guides at
<https://infisical.com/docs/documentation/platform/secrets-mgmt/quick-starts/deliver-first-secret>.

## Cleanup

- `.env` is already gitignored; check that a new one never sneaks in by running
  `git status` before committing. Keep `.env.example` empty of real values — it is the
  template, and it is tracked.
- Commit `android/.infisical.json` (project settings only, no secrets).
- **If a real key was ever committed, rotate it.** Git history keeps it forever, so
  deleting the line does not help; make a new key in sieve and revoke the old one.
  Infisical's scanner finds leaks in a repo, a directory or a commit range:
  <https://infisical.com/docs/cli/scanning-overview>.

## When not to do this

If you already run a secrets manager for this project — one that actually holds the
values — stop here and point the tooling at that instead of Infisical. Likewise, if the
sieve key is a throwaway you are about to delete, the local `.env` is fine and this
document is not worth the setup.

## Reference

- Install the CLI — <https://infisical.com/docs/cli/overview>
- CLI quickstart (login, `init`, `run`) — <https://infisical.com/docs/cli/usage>
- Deliver your first secret — <https://infisical.com/docs/documentation/platform/secrets-mgmt/quick-starts/deliver-first-secret>
- Machine identities — <https://infisical.com/docs/documentation/platform/identities/machine-identities>
- Universal Auth — <https://infisical.com/docs/documentation/platform/identities/universal-auth>
