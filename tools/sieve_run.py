#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CLI for the sieve scrape API. See sieve.py for the client and SIEVE.md for the tour.

Usage (the wrapped form is the default; SIEVE_API_KEY comes from Infisical):
  infisical run --env=dev -- python tools/sieve_run.py run "Extract ..." --url https://example.com
  infisical run --env=dev -- python tools/sieve_run.py run "Extract ..." --fields author,quote
  python tools/sieve_run.py doctor                     # where the key comes from (never prints it)
  python tools/sieve_run.py login                      # device login; writes SIEVE_API_KEY to .env
  python tools/sieve_run.py resume <session_id>         # keep polling a run after a crash
  python tools/sieve_run.py status <session_id>
  python tools/sieve_run.py monitors <session_id>

Runs and their files land under stage/sieve/<session_id>/. The key is read from
SIEVE_API_KEY in the environment first (that is how `infisical run` delivers it) and
only then from a .env file, so it can never be printed here. `doctor` reports which
of the two answered, and every command warns when it had to fall back to the file.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

import sieve

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DEFAULT_ENV = os.path.join(REPO, ".env")
DEFAULT_OUT = os.path.join(REPO, "stage", "sieve")

NO_KEY_HINT = ("No SIEVE_API_KEY. Store it in Infisical (see SECRETS.md) and start this "
               "command through the CLI: infisical run --env=dev -- python tools/sieve_run.py "
               "...  To bootstrap a key by hand instead, run: python tools/sieve_run.py login. "
               "`python tools/sieve_run.py doctor` shows what resolved, and from where.")

INFISICAL_HINT = ("Install the Infisical CLI (winget install infisical, "
                  "brew install infisical/get-cli/infisical, or npm install -g @infisical/cli), "
                  "then log in and link this repo with `infisical init`. SECRETS.md has the "
                  "full walkthrough.")

MIGRATE_HINT = ("Still reading a file. Put SIEVE_API_KEY in Infisical (see SECRETS.md), start "
                "this command through `infisical run --env=dev -- python tools/sieve_run.py ...`, "
                "then delete the local copy.")


def _key_origin(env_path):
    """Where the key actually resolves from, decided by the real client code path.

    Uses the environment check and ``sieve.client_from_env`` itself rather than
    re-deriving the precedence, so this diagnostic can never drift from what the
    run/status/resume commands actually do. Returns None when nothing supplies it.
    """
    if os.environ.get("SIEVE_API_KEY"):
        return "environment"
    if sieve.client_from_env(env_path, sleep=time.sleep).api_key:
        return env_path
    return None


def _client(args):
    env_path = args.env_file or DEFAULT_ENV
    client = sieve.client_from_env(env_path, sleep=time.sleep)
    if not client.configured:
        sys.exit(NO_KEY_HINT)
    if not os.environ.get("SIEVE_API_KEY"):
        # The run still works, so this is a warning rather than an error. It is loud
        # because a silently-read android/.env is exactly what makes a half-finished
        # Infisical migration look finished.
        print("sieve: SIEVE_API_KEY came from %s, not the environment. Run this through "
              "`infisical run --env=dev -- ...` (see SECRETS.md)." % env_path, file=sys.stderr)
    return client


def _load_schema(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def cmd_login(args):
    try:
        key, key_name = sieve.device_login(args.client_name, out=print)
    except sieve.Unauthorized:
        print("The sieve host rejected the device-code request (401), so device login is not\n"
              "available on this deployment. Create a key instead:\n"
              "  sieve -> Settings -> API keys -> create, then store it in Infisical\n"
              "  (SECRETS.md) or, as a bootstrap, add it to android/.env:\n"
              "  SIEVE_API_KEY=<the key>   (android/.env is gitignored)", file=sys.stderr)
        return 1
    path = sieve.write_env_secret(args.env_file or DEFAULT_ENV, "SIEVE_API_KEY", key)
    print("Login approved. Wrote SIEVE_API_KEY to %s" % path)
    if key_name:
        print("Key name: %s" % key_name)
    print("Keep this file out of git; it is gitignored by the repo.")
    print("Next: drag that file onto the Infisical Secrets Overview page to import the key,\n"
          "then delete the local copy and run through `infisical run` (see SECRETS.md).")
    return 0


def _infisical_config():
    """The first .infisical.json `infisical run` would find, as ``(path, parsed)``.

    The file holds only local project settings - a project and an environment slug -
    so its contents are never secret and are safe to commit.
    """
    for directory in (os.getcwd(), REPO):
        path = os.path.join(directory, ".infisical.json")
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as handle:
                    return path, json.load(handle)
            except (OSError, ValueError):
                return path, None
    return None, None


def cmd_doctor(args):
    """Report where SIEVE_API_KEY comes from. Prints the key's length, never its value."""
    env_path = args.env_file or DEFAULT_ENV
    source = _key_origin(env_path)
    print("sieve doctor - where SIEVE_API_KEY comes from. Values are never printed.")
    print("")
    if source == "environment":
        print("  SIEVE_API_KEY    from the environment (%d chars) - injected, not on disk"
              % len(os.environ["SIEVE_API_KEY"]))
    elif source:
        key = sieve.load_env_file(source).get("SIEVE_API_KEY") or ""
        print("  SIEVE_API_KEY    from %s (%d chars) - still a file on this machine"
              % (source, len(key)))
    else:
        print("  SIEVE_API_KEY    missing")

    from_env = os.environ.get("SIEVE_BASE_URL")
    print("  SIEVE_BASE_URL   %s%s" % (sieve.BASE_URL, "" if from_env else " (default)"))

    cli = shutil.which("infisical")
    print("  infisical CLI    %s" % (cli or "not found on PATH"))

    config_path, config = _infisical_config()
    if config:
        print("  .infisical.json  %s (defaultEnvironment: %s)"
              % (config_path, config.get("defaultEnvironment", "unset")))
    elif config_path:
        print("  .infisical.json  %s (unreadable)" % config_path)
    else:
        print("  .infisical.json  none in %s" % REPO)

    print("  local .env       %s" % ("present" if os.path.isfile(env_path) else "absent"))
    print("")

    if source == "environment":
        print("Good: the key was injected into the process, so nothing on disk was read.")
        if os.path.isfile(env_path):
            print("The copy at %s is now only a shadowed fallback and can be deleted." % env_path)
        return 0
    if source:
        print(MIGRATE_HINT)
    else:
        print(NO_KEY_HINT)
    if not cli:
        print(INFISICAL_HINT)
    return 0 if source else 1


def cmd_run(args):
    client = _client(args)
    schema = _load_schema(args.output_schema) if args.output_schema else None
    document = None
    if args.document:
        with open(args.document, "rb") as handle:
            document = handle.read()
    store = sieve.SessionStore(args.out)
    outcome = sieve.stage_run(
        client, store,
        instruction=args.instruction,
        out_root=args.out,
        document=document,
        document_name=os.path.basename(args.document) if args.document else "document",
        compliance_mode=args.compliance,
        target_urls=args.url or None,
        fields=args.fields.split(",") if args.fields else None,
        output_schema=schema,
        table_shape=args.shape,
        progress=lambda line: print("  " + line),
    )
    return _report(outcome)


def cmd_resume(args):
    client = _client(args)
    store = sieve.SessionStore(args.out)
    record = store.load(args.session_id)
    if not record:
        sys.exit("No session %s under %s" % (args.session_id, args.out))
    outcome = sieve.stage_run(
        client, store, instruction=record.get("instruction", ""),
        out_root=args.out, resume=args.session_id,
        compliance_mode=args.compliance,
        progress=lambda line: print("  " + line),
    )
    return _report(outcome)


def cmd_status(args):
    client = _client(args)
    run = client.get_run(args.session_id)
    print(json.dumps({"status": run.get("status"), "turns": sieve.turns_count(run),
                      "schema_conformance": run.get("schema_conformance")}, indent=2))
    return 0


def cmd_monitors(args):
    client = _client(args)
    print(json.dumps(client.list_monitors(args.session_id), indent=2, ensure_ascii=False))
    return 0


def _report(outcome):
    if outcome.get("status") == "refused":
        refusal = outcome.get("refusal") or {}
        print("Run refused (%s): %s" % (refusal.get("code"), refusal.get("message", "")))
        print("Nothing was scraped. Record: %s" % outcome["dir"])
        return 2
    if outcome.get("warning"):
        print("!! " + outcome["warning"])
    print("Done. session_id=%s" % outcome["session_id"])
    print("  summary: %s" % (outcome.get("summary") or {}))
    print("  files:   %s" % out_list(outcome.get("files")))
    print("  fetched: %s" % out_list(outcome.get("downloaded")))
    print("  output:  %s" % outcome["dir"])
    return 0


def out_list(items):
    return ", ".join(items) if items else "(none)"


def build_parser():
    parser = argparse.ArgumentParser(description="Run sieve scrapes for SphereDex staging.")
    parser.add_argument("--env-file", default=None, help="dotenv file (default: android/.env)")
    parser.add_argument("--out", default=DEFAULT_OUT, help="where runs are stored (default: stage/sieve)")
    sub = parser.add_subparsers(dest="command", required=True)

    login = sub.add_parser("login", help="device login; writes SIEVE_API_KEY to .env")
    login.add_argument("--client-name", default="SphereDex staging",
                       help="tool name shown to the approver (self-reported)")
    login.set_defaults(func=cmd_login)

    doctor = sub.add_parser("doctor", help="show where SIEVE_API_KEY resolves from")
    doctor.set_defaults(func=cmd_doctor)

    run = sub.add_parser("run", help="start a scrape and stage its output")
    run.add_argument("instruction", help="plain-language instruction")
    run.add_argument("--url", action="append", default=[], help="public http(s) page (repeatable)")
    run.add_argument("--fields", default=None, help="comma-separated expected columns")
    run.add_argument("--output-schema", default=None, help="strict JSON Schema file (<= 32KB)")
    run.add_argument("--shape", choices=["long", "wide"], default=None)
    run.add_argument("--compliance", choices=["conservative", "regular", "yolo"],
                     default=sieve.DEFAULT_COMPLIANCE,
                     help="regular unless the user explicitly chooses otherwise")
    run.add_argument("--document", default=None, help="upload a document (multipart)")
    run.set_defaults(func=cmd_run)

    resume = sub.add_parser("resume", help="keep polling a run after a crash")
    resume.add_argument("session_id")
    resume.add_argument("--compliance", choices=["conservative", "regular", "yolo"],
                        default=sieve.DEFAULT_COMPLIANCE)
    resume.set_defaults(func=cmd_resume)

    status = sub.add_parser("status", help="show a run's status")
    status.add_argument("session_id")
    status.set_defaults(func=cmd_status)

    monitors = sub.add_parser("monitors", help="list a run's monitors")
    monitors.add_argument("session_id")
    monitors.set_defaults(func=cmd_monitors)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except sieve.SieveError as exc:
        print("sieve: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
