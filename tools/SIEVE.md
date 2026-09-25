# sieve scrape API tooling

Server-side only. `tools/sieve.py` is the client and `tools/sieve_run.py` is the CLI. They
use the same standard-library `urllib` client as the other tools, write under `stage/`, and
are opt-in: nothing here runs at app start-up, so the web, Android and iOS bundles behave
exactly as before when sieve is not configured.

The API key has full account access and no scopes, so it lives in `SIEVE_API_KEY` and is
never written into a built page, a log line, or stage output. Its home is Infisical, which
injects it as an environment variable at run time; `android/.env` is only a local fallback
for bootstrapping. **[SECRETS.md](../SECRETS.md) is the runbook** — read it before moving
the key anywhere.

## Check what the tooling is reading

```bash
python tools/sieve_run.py doctor
```

Reports where `SIEVE_API_KEY` resolved from — the environment (an `infisical run`-wrapped
command, CI, a container) or a file on this machine — plus its **length**, never its value.
Exits non-zero when nothing supplies a key, so it can gate a script. Every other command
warns on stderr when it had to fall back to `.env`, so a half-finished migration cannot
quietly pass for a finished one.

## Get a key (once, with you present)

```bash
python tools/sieve_run.py login
```

This asks sieve for a device code, prints the `verification_uri_complete` link and the
`user_code`, and polls until you approve in the browser. It never opens the link or
approves for you. On success it writes `SIEVE_API_KEY` into `android/.env` (gitignored)
without printing the key. Already have a key? Create one under Settings -> API keys.

Either way the key belongs in Infisical, not in that file: import it (the Secrets Overview
page accepts a drag-and-dropped `.env`), then delete the local copy and run the tooling
through `infisical run`. See [SECRETS.md](../SECRETS.md).

## Run a scrape

```bash
infisical run --env=dev -- python tools/sieve_run.py run \
    "Extract the text and author of each quote" \
    --url https://quotes.toscrape.com --fields quote,author --shape long
```

- `--output-schema FILE` adds a strict JSON Schema (<= 32 KB); a passing run returns the
  validated payload inline and it is written to `result.json`.
- `--document FILE` uploads a document instead of scraping URLs (multipart `file` field).
- `--compliance conservative|regular|yolo`; `regular` is the default and `yolo` relaxes
  the site-access policy, so it is only used when you explicitly ask for it.

Output lands in `stage/sieve/<session_id>/`:

- `summary.json` - status, summary, `files[]`, `schema_conformance`
- `result.json` - the inline result, or `result.unverified.json` when
  `schema_conformance.status` is `fail` (never presented as clean data)
- `files/` - each delivered file, fetched with the Bearer header

The session record (`stage/sieve/<session_id>.json`) is written the moment the run is
accepted, before the first poll, so a crash resumes instead of starting a duplicate run:

```bash
python tools/sieve_run.py resume <session_id>
python tools/sieve_run.py status <session_id>
python tools/sieve_run.py monitors <session_id>
```

## Contract behaviours the client encodes

- `POST /api/scrapes` has no idempotency key and spends credits, so a timeout or network
  error is **never** retried; 429 and 5xx are (no run was created).
- Status polling runs 5s -> ~30s; `running` keeps polling, `done` finishes, `refused` is
  terminal (the run never started, `refusal.code` says why, `refusal.quota` for credits)
  and any other status is an error.
- Follow-up turns (`.../messages`) are recorded first, then polled until `done` **and** the
  turn counter has advanced; `409` waits and resends.
- A GET is retried on 5xx/network with backoff; a 429 waits `Retry-After`.

## Tests

```bash
python tools/test_sieve.py        # client: requests, polling, retries, secrets, login
python tools/test_sieve_run.py    # CLI: where the key comes from, doctor, leak checks
```

The HTTP boundary is the only thing faked, so the logic under test is the real code. The
CLI tests spend no credits and never touch the network.
