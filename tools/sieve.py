#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Server-side client for the sieve scrape API (https://scrape.usesieve.com).

This is the one place in the project that talks to sieve. It follows the shape of the
other tools here: standard library only (urllib, the same client fetch_pal_art.py and
stage_set.py already use), JSON written under stage/, and an argparse CLI (sieve_run.py).

Nothing here runs at app start-up and no built page imports it, so the web, Android and
iOS bundles behave exactly as before when sieve is not configured. The API key is
account-wide (no scopes), so it is read from the environment (or a gitignored .env) and
is never written into a built page, a log line, or stage output.

Contract notes the code below encodes on purpose:

* Every request carries ``Authorization: Bearer $SIEVE_API_KEY``.
* ``POST /api/scrapes`` has no idempotency key and an accepted call spends credits, so a
  timeout or network failure is NEVER retried (the first call may have succeeded).
  429 and 5xx are safe to retry because no run was created.
* The run's ``session_id`` is persisted durably before the first poll, so a crash resumes
  polling instead of starting a duplicate run.
* Polling starts at 5s and backs off to ~30s; runs take minutes, so there is no short
  overall timeout unless the caller asks for one.
* ``status`` is only ever running / done / refused; anything else is an error.
* A run whose ``schema_conformance.status`` is "fail" is never handed over as clean data.
"""

from __future__ import annotations

import io
import json
import os
import time
import urllib.error
import urllib.request
import uuid

# The build, not the device, owns the base URL (the same rule the app uses for its own
# backend); SIEVE_BASE_URL is a test/self-host escape hatch, not app configuration.
BASE_URL = os.environ.get("SIEVE_BASE_URL", "https://scrape.usesieve.com").rstrip("/")

DEFAULT_COMPLIANCE = "regular"          # "yolo" is the user's call, never a default
OUTPUT_SCHEMA_MAX = 32 * 1024           # 32 KB cap from the API contract
POLL_START = 5.0                        # seconds between the first status polls
POLL_MAX = 30.0                         # ... backing off to about half a minute
RETRY_START = 0.5                       # HTTP-level retry backoff (not the run poll)
RETRY_MAX = 8.0


# --------------------------------------------------------------------------------------
# Transport boundary
# --------------------------------------------------------------------------------------
class NetworkError(Exception):
    """A request that never produced an HTTP response (DNS, TLS, timeout, reset)."""


class Transport:
    """The HTTP boundary. Swapped for a recording fake in tests."""

    def request(self, method, url, headers, body, timeout):
        """Return ``(status, headers, body_bytes)``. Raise NetworkError on transport failure."""
        raise NotImplementedError


class UrllibTransport(Transport):
    """Default transport: urllib.request, the project's existing HTTP client."""

    def request(self, method, url, headers, body, timeout):
        req = urllib.request.Request(url, data=body, method=method)
        for key, value in headers.items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as exc:                       # a response, not a failure
            return exc.code, dict(exc.headers or {}), exc.read()
        except Exception as exc:                                    # noqa: BLE001 - boundary
            raise NetworkError(str(exc))


def _header(headers, name):
    for key, value in (headers or {}).items():
        if key.lower() == name.lower():
            return value
    return None


def _retry_after(headers):
    raw = _header(headers, "Retry-After")
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------------------
class SieveError(Exception):
    """Any failure talking to sieve, or a run that did not finish cleanly."""

    def __init__(self, message, *, status=None, payload=None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.payload = payload
        self.retry_after = retry_after


class BadRequest(SieveError):        # 400 - fix the request, do not retry
    pass


class Unauthorized(SieveError):      # 401/403 - key missing or revoked
    pass


class PaymentRequired(SieveError):   # 402 - out of credits
    pass


class NotFound(SieveError):          # 404 - not found, or not the caller's
    pass


class Conflict(SieveError):          # 409 - a turn is already in flight
    pass


class RateLimited(SieveError):       # 429 - wait Retry-After
    pass


class ServerError(SieveError):       # 5xx
    pass


class RunRefused(SieveError):
    """Terminal: the run never started. ``refusal`` carries the API's reason."""

    def __init__(self, payload):
        refusal = (payload or {}).get("refusal") or {}
        code = refusal.get("code") or "unknown"
        super().__init__("sieve refused the run: " + str(code), payload=payload)
        self.refusal = refusal
        self.code = code


class UnexpectedStatus(SieveError):
    """A status outside the documented running / done / refused set."""


def _error_for(status, headers, payload):
    detail = ""
    if isinstance(payload, dict):
        detail = payload.get("error") or payload.get("message") or ""
    detail = (" - " + str(detail)) if detail else ""
    after = _retry_after(headers)
    if status == 400:
        return BadRequest("sieve rejected the request (400)" + detail, status=status, payload=payload)
    if status == 401:
        return Unauthorized("sieve key missing or revoked (401)" + detail, status=status, payload=payload)
    if status == 402:
        return PaymentRequired("sieve out of credits (402)" + detail, status=status, payload=payload)
    if status == 403:
        return Unauthorized("sieve refused this key (403)" + detail, status=status, payload=payload)
    if status == 404:
        return NotFound("sieve has no such run (404)" + detail, status=status, payload=payload)
    if status == 409:
        return Conflict("a sieve turn is already in flight (409)" + detail, status=status, payload=payload)
    if status == 429:
        return RateLimited("sieve rate limit (429)" + detail, status=status, payload=payload,
                           retry_after=after)
    if 500 <= status < 600:
        return ServerError("sieve server error (%d)%s" % (status, detail), status=status, payload=payload)
    return SieveError("unexpected sieve response (%d)%s" % (status, detail), status=status, payload=payload)


# --------------------------------------------------------------------------------------
# Request body building
# --------------------------------------------------------------------------------------
def run_body(instruction, *, target_urls=None, fields=None, schema=None, output_schema=None,
             table_shape=None, compliance_mode=None):
    """The JSON body shared by POST /api/scrapes and the follow-up .../messages endpoint."""
    if not instruction or not str(instruction).strip():
        raise ValueError("instruction is required")
    body = {"instruction": str(instruction)}
    if target_urls:
        body["target_urls"] = list(target_urls)
    if fields:
        body["fields"] = list(fields)
    if schema is not None:
        body["schema"] = schema
    if output_schema is not None:
        text = output_schema if isinstance(output_schema, str) else json.dumps(output_schema)
        if len(text.encode("utf-8")) > OUTPUT_SCHEMA_MAX:
            raise ValueError("output_schema exceeds the 32KB cap")
        body["output_schema"] = json.loads(text) if isinstance(output_schema, str) else output_schema
    if table_shape:
        body["table_shape"] = table_shape
    body["compliance_mode"] = compliance_mode or DEFAULT_COMPLIANCE
    return body


def encode_multipart(form, files):
    """Encode ``multipart/form-data`` without a third-party dependency."""
    boundary = "----sieve" + uuid.uuid4().hex
    out = io.BytesIO()
    for name, value in form.items():
        out.write(("--%s\r\n" % boundary).encode("ascii"))
        out.write(('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode("utf-8"))
        out.write((value if isinstance(value, str) else json.dumps(value)).encode("utf-8"))
        out.write(b"\r\n")
    for name, filename, content in files:
        out.write(("--%s\r\n" % boundary).encode("ascii"))
        out.write(('Content-Disposition: form-data; name="%s"; filename="%s"\r\n'
                   % (name, filename)).encode("utf-8"))
        out.write(b"Content-Type: application/octet-stream\r\n\r\n")
        out.write(content if isinstance(content, bytes) else content.encode("utf-8"))
        out.write(b"\r\n")
    out.write(("--%s--\r\n" % boundary).encode("ascii"))
    return out.getvalue(), "multipart/form-data; boundary=" + boundary


# --------------------------------------------------------------------------------------
# Client
# --------------------------------------------------------------------------------------
class SieveClient:
    """A thin, retry-aware wrapper around the sieve REST API."""

    def __init__(self, api_key=None, *, base_url=BASE_URL, transport=None, timeout=60.0,
                 sleep=time.sleep, max_attempts=5):
        self.api_key = api_key if api_key is not None else os.environ.get("SIEVE_API_KEY")
        self.base_url = (base_url or BASE_URL).rstrip("/")
        self.transport = transport or UrllibTransport()
        self.timeout = timeout
        self.sleep = sleep
        self.max_attempts = max_attempts

    @property
    def configured(self):
        return bool(self.api_key)

    def _headers(self, extra=None):
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = "Bearer " + self.api_key
        if extra:
            headers.update(extra)
        return headers

    def _call(self, method, path, *, json_body=None, multipart=None, retry_network=False,
              accept_errors=(), sleep=None, raw=False):
        """Perform one logical request.

        Returns ``(status, payload)`` (or ``(status, raw_bytes)`` when ``raw`` is set).
        Raises a SieveError for a non-2xx status not listed in ``accept_errors``. 429 and
        5xx are retried with backoff (safe: no run was created). Transport failures are
        only retried when ``retry_network`` is true - the run-creating POST passes false
        precisely so a timeout is never retried.
        """
        sleep = sleep or self.sleep
        if path.startswith("http://") or path.startswith("https://"):
            url = path
        else:
            url = self.base_url + (path if path.startswith("/") else "/" + path)
        if multipart is not None:
            body, content_type = multipart
            headers = self._headers({"Content-Type": content_type})
        elif json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
            headers = self._headers({"Content-Type": "application/json"})
        else:
            body, headers = None, self._headers()

        delay = RETRY_START
        for attempt in range(1, self.max_attempts + 1):
            try:
                status, response_headers, raw_body = self.transport.request(
                    method, url, headers, body, self.timeout)
            except NetworkError as exc:
                if not retry_network or attempt >= self.max_attempts:
                    raise SieveError("sieve request failed: %s" % exc) from exc
                sleep(delay)
                delay = min(delay * 2, RETRY_MAX)
                continue

            payload = raw_body if raw else self._parse(raw_body)
            if status in accept_errors:
                return status, payload
            if (status == 429 or 500 <= status < 600) and attempt < self.max_attempts:
                wait = _retry_after(response_headers)
                sleep(wait if wait is not None else delay)
                delay = min(delay * 2, RETRY_MAX)
                continue
            if 200 <= status < 300:
                return status, payload
            raise _error_for(status, response_headers, self._parse(raw_body))
        raise SieveError("sieve request failed after %d attempts" % self.max_attempts)

    @staticmethod
    def _parse(raw):
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return {"raw": raw.decode("utf-8", "replace")[:2000]}

    # -- runs --------------------------------------------------------------------------
    def start_run(self, instruction, *, target_urls=None, fields=None, schema=None,
                  output_schema=None, table_shape=None, compliance_mode=None,
                  document=None, document_name="document"):
        """POST /api/scrapes. Returns the 202 payload; never retried on a timeout."""
        body = run_body(instruction, target_urls=target_urls, fields=fields, schema=schema,
                        output_schema=output_schema, table_shape=table_shape,
                        compliance_mode=compliance_mode)
        if document is not None:
            form = {k: (v if isinstance(v, str) else json.dumps(v)) for k, v in body.items()}
            multipart = encode_multipart(form, [("file", document_name, document)])
            payload = self._call("POST", "/api/scrapes", multipart=multipart,
                                 retry_network=False)[1]
        else:
            payload = self._call("POST", "/api/scrapes", json_body=body, retry_network=False)[1]
        if not isinstance(payload, dict) or not payload.get("session_id"):
            raise SieveError("sieve did not return a session_id", payload=payload)
        return payload

    def get_run(self, session_id):
        """GET /api/scrapes/<id>. Retried on 5xx and transport failures."""
        return self._call("GET", "/api/scrapes/" + session_id, retry_network=True)[1]

    def poll(self, session_id, *, on_update=None, sleep=None, max_wait=None, clock=time.monotonic):
        """Poll until the run is done. 5s -> ~30s backoff; refused and other statuses raise."""
        sleep = sleep or self.sleep
        delay, started = POLL_START, clock()
        while True:
            run = self.get_run(session_id)
            if on_update:
                on_update(run)
            status = run.get("status") if isinstance(run, dict) else None
            if status == "done":
                return run
            if status == "refused":
                raise RunRefused(run)
            if status != "running":
                raise UnexpectedStatus("unknown sieve status %r" % (status,), payload=run)
            if max_wait is not None and clock() - started > max_wait:
                raise SieveError("sieve run still running after %ss" % max_wait, payload=run)
            sleep(delay)
            delay = min(delay * 2, POLL_MAX)

    # -- follow-up turns ---------------------------------------------------------------
    def send_message(self, session_id, instruction, *, target_urls=None, fields=None,
                     schema=None, output_schema=None, table_shape=None, compliance_mode=None,
                     sleep=None, conflict_wait=5.0):
        """POST .../messages. 409 means a turn is in flight: wait, then resend."""
        sleep = sleep or self.sleep
        body = run_body(instruction, target_urls=target_urls, fields=fields, schema=schema,
                        output_schema=output_schema, table_shape=table_shape,
                        compliance_mode=compliance_mode)
        path = "/api/scrapes/%s/messages" % session_id
        while True:
            status, payload = self._call("POST", path, json_body=body, retry_network=False,
                                         accept_errors=(409,))
            if status == 409:
                sleep(conflict_wait)
                continue
            return payload

    def follow_up(self, session_id, instruction, *, sleep=None, progress=None, **fields):
        """Record a turn, then poll until done AND the turn counter advanced."""
        sleep = sleep or self.sleep
        base = turns_count(self.get_run(session_id))
        if progress:
            progress("recorded follow-up turn (turns=%d)" % base)
        self.send_message(session_id, instruction, sleep=sleep, **fields)
        delay = POLL_START
        while True:
            run = self.get_run(session_id)
            if progress:
                progress("status=%s turns=%d" % (run.get("status"), turns_count(run)))
            status = run.get("status") if isinstance(run, dict) else None
            if status == "refused":
                raise RunRefused(run)
            if status == "done" and turns_count(run) > base:
                return run
            if status not in ("running", "done"):
                raise UnexpectedStatus("unknown sieve status %r" % (status,), payload=run)
            sleep(delay)
            delay = min(delay * 2, POLL_MAX)

    # -- files -------------------------------------------------------------------------
    def file_url(self, file):
        url = (file or {}).get("url") or ""
        if url.startswith("http://") or url.startswith("https://"):
            return url
        return self.base_url + "/" + url.lstrip("/")

    def download_file(self, file):
        """Delivered-file bytes. ``url`` is relative, so prefix the base and send the key."""
        _, body = self._call("GET", self.file_url(file), retry_network=True, raw=True)
        return body or b""

    # -- credits -----------------------------------------------------------------------
    def credits(self):
        return self._call("GET", "/api/me/credits", retry_network=True)[1]

    # -- monitors (optional: only needed for scheduled refreshes) -----------------------
    def create_monitor(self, session_id, instruction, *, schedule_kind, **fields):
        body = {"instruction": instruction, "schedule_kind": schedule_kind}
        for key in ("schedule_time", "schedule_timezone", "email_recipients", "webhook_url",
                    "notify_only_if_changed"):
            if fields.get(key) is not None:
                body[key] = fields[key]
        return self._call("POST", "/api/scrapes/%s/monitor" % session_id, json_body=body,
                          retry_network=False)[1]

    def list_monitors(self, session_id):
        return self._call("GET", "/api/sessions/%s/monitors" % session_id,
                          retry_network=True)[1]

    def trigger_monitor(self, monitor_id):
        return self._call("POST", "/api/monitors/%s/runs" % monitor_id, retry_network=False)[1]

    def get_monitor_run(self, monitor_id, run_id):
        return self._call("GET", "/api/monitors/%s/runs/%s" % (monitor_id, run_id),
                          retry_network=True)[1]

    def get_monitor_results(self, monitor_id, run_id):
        return self._call("GET", "/api/monitors/%s/runs/%s/results" % (monitor_id, run_id),
                          retry_network=True)[1]

    def poll_monitor_run(self, monitor_id, run_id, *, sleep=None, progress=None):
        """Poll a triggered run until changed / no_change / failed, then read its results."""
        sleep = sleep or self.sleep
        delay = POLL_START
        while True:
            run = self.get_monitor_run(monitor_id, run_id)
            status = run.get("status") if isinstance(run, dict) else None
            if progress:
                progress("monitor run %s" % status)
            if status in ("changed", "no_change", "failed"):
                return run
            if status not in ("running", "queued"):
                raise UnexpectedStatus("unknown monitor run status %r" % (status,), payload=run)
            sleep(delay)
            delay = min(delay * 2, POLL_MAX)


# --------------------------------------------------------------------------------------
# Status helpers
# --------------------------------------------------------------------------------------
def turns_count(run):
    turns = (run or {}).get("turns")
    if isinstance(turns, bool):
        return 0
    if isinstance(turns, (int, float)):
        return int(turns)
    if isinstance(turns, (list, dict)):
        return len(turns)
    return 0


def conformance(run):
    """schema_conformance.status, or "not_checkable" when the run carries none."""
    block = (run or {}).get("schema_conformance") or {}
    return block.get("status") or "not_checkable"


def is_clean(run):
    """False only for output the contract says must not be presented as clean data."""
    return conformance(run) != "fail"


# --------------------------------------------------------------------------------------
# Durable session store
# --------------------------------------------------------------------------------------
class SessionStore:
    """One JSON file per run under stage/, written atomically so a crash can resume."""

    def __init__(self, root):
        self.root = root

    def path(self, session_id):
        return os.path.join(self.root, session_id + ".json")

    def save(self, session_id, record):
        os.makedirs(self.root, exist_ok=True)
        target = self.path(session_id)
        tmp = target + ".tmp"
        with io.open(tmp, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, target)
        return target

    def update(self, session_id, **fields):
        record = self.load(session_id) or {"session_id": session_id}
        record.update(fields)
        return self.save(session_id, record)

    def load(self, session_id):
        try:
            with io.open(self.path(session_id), encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError):
            return None

    def sessions(self):
        if not os.path.isdir(self.root):
            return []
        return sorted(name[:-5] for name in os.listdir(self.root) if name.endswith(".json"))


# --------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------
def stage_run(client, store, *, instruction, out_root, resume=None, document=None,
              document_name="document", compliance_mode=DEFAULT_COMPLIANCE, sleep=None,
              progress=None, **fields):
    """Start (or resume) one run, persist its session first, then poll to a terminal state.

    Returns a small outcome dict. On refusal the record is stored and no result is written,
    so a refused run can never be mistaken for an empty-but-clean one.
    """
    sleep = sleep or client.sleep
    session_id = resume
    if session_id is None:
        started = client.start_run(instruction, document=document, document_name=document_name,
                                   compliance_mode=compliance_mode, **fields)
        session_id = started["session_id"]
        # Persist BEFORE the first poll: a crash here resumes instead of re-spending credits.
        store.save(session_id, {"session_id": session_id, "status": "queued",
                                "poll": started.get("poll"), "instruction": instruction})
    elif progress:
        progress("resuming run %s" % session_id)

    run_dir = os.path.join(out_root, session_id)
    os.makedirs(run_dir, exist_ok=True)

    def on_update(run):
        store.update(session_id, status=(run or {}).get("status"), turns=turns_count(run))
        if progress:
            progress("status=%s turns=%d" % ((run or {}).get("status"), turns_count(run)))

    try:
        run = client.poll(session_id, on_update=on_update, sleep=sleep)
    except RunRefused as exc:
        store.update(session_id, status="refused", refusal=exc.refusal)
        return {"session_id": session_id, "status": "refused", "refusal": exc.refusal,
                "dir": run_dir}

    store.update(session_id, status="done", summary=run.get("summary"),
                 schema_conformance=run.get("schema_conformance"),
                 files=[f.get("name") for f in (run.get("files") or [])])

    written = {}
    if "result" in run:
        clean = is_clean(run)
        name = "result.json" if clean else "result.unverified.json"
        with io.open(os.path.join(run_dir, name), "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(run["result"], ensure_ascii=False, indent=2) + "\n")
        written["result"] = name
        if not clean:
            written["warning"] = ("schema_conformance.status=fail: NOT clean data (%s)"
                                  % conformance(run))

    files_dir = os.path.join(run_dir, "files")
    downloaded = []
    for file in run.get("files") or []:
        os.makedirs(files_dir, exist_ok=True)
        name = os.path.basename((file or {}).get("name") or "file")
        with io.open(os.path.join(files_dir, name), "wb") as handle:
            handle.write(client.download_file(file))
        downloaded.append(name)

    summary = {"session_id": session_id, "status": "done", "summary": run.get("summary"),
               "schema_conformance": run.get("schema_conformance"),
               "files": [f.get("name") for f in (run.get("files") or [])],
               "downloaded": downloaded, "result": written.get("result"),
               "warning": written.get("warning"), "dir": run_dir}
    with io.open(os.path.join(run_dir, "summary.json"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return summary


# --------------------------------------------------------------------------------------
# Secrets / .env
# --------------------------------------------------------------------------------------
def load_env_file(path):
    """Minimal .env reader (KEY=VALUE, # comments). Values are never logged."""
    values = {}
    try:
        with io.open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        return {}
    return values


def write_env_secret(path, name, value):
    """Set NAME=value in a dotenv file, preserving other lines. Never prints the value."""
    lines, found = [], False
    try:
        with io.open(path, encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if stripped.startswith(name + "=") or stripped.startswith(name + " ="):
                    lines.append("%s=%s\n" % (name, value))
                    found = True
                elif stripped:
                    lines.append(line if line.endswith("\n") else line + "\n")
    except OSError:
        pass
    if not found:
        lines.append("%s=%s\n" % (name, value))
    directory = os.path.dirname(os.path.abspath(path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("".join(lines))
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)                                    # best effort on POSIX
    except OSError:
        pass
    return path


def client_from_env(env_path=None, **kwargs):
    """Build a client. A real SIEVE_API_KEY wins; otherwise fall back to a .env file."""
    if kwargs.get("api_key") is None and not os.environ.get("SIEVE_API_KEY") and env_path:
        key = load_env_file(env_path).get("SIEVE_API_KEY")
        if key:
            kwargs["api_key"] = key
    return SieveClient(**kwargs)


# --------------------------------------------------------------------------------------
# Device login
# --------------------------------------------------------------------------------------
class DeviceLoginDenied(SieveError):
    pass


class DeviceLoginExpired(SieveError):
    pass


def device_login(client_name, *, base_url=BASE_URL, transport=None, timeout=30.0,
                 sleep=time.sleep, max_restarts=3, clock=time.monotonic, out=print):
    """Run the device-code flow and return ``(api_key, key_name)``.

    Shows the user ``verification_uri_complete`` and ``user_code`` and points them at a
    browser; it never opens the link, signs in, or approves on their behalf. The key is
    returned to the caller and is never printed.
    """
    transport = transport or UrllibTransport()
    base = (base_url or BASE_URL).rstrip("/")

    def post(path, body):
        raw = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        status, headers_out, payload_raw = transport.request("POST", base + path, headers, raw, timeout)
        try:
            payload = json.loads(payload_raw.decode("utf-8")) if payload_raw else None
        except (UnicodeDecodeError, ValueError):
            payload = {"raw": payload_raw.decode("utf-8", "replace")[:2000]}
        return status, headers_out, payload

    restarts = 0
    while True:
        status, _, code = post("/api/auth/device/code", {"client_name": client_name})
        if status != 200 or not isinstance(code, dict):
            raise _error_for(status, {}, code)
        interval = float(code.get("interval") or 5)
        expires_in = float(code.get("expires_in") or 600)
        out("")
        out("To approve this device, open:")
        out("  " + str(code.get("verification_uri_complete") or code.get("verification_uri") or ""))
        out("and confirm the code shown matches: " + str(code.get("user_code", "")))
        out("")
        out("Only approve a code you started yourself. The tool name in the prompt is")
        out("self-reported by this script, not verified by sieve.")
        out("")

        deadline = clock() + expires_in
        while clock() < deadline:
            status, headers_out, token = post("/api/auth/device/token",
                                              {"device_code": code.get("device_code")})
            if status == 200 and isinstance(token, dict) and token.get("api_key"):
                return token["api_key"], token.get("key_name") or ""
            if status == 200:
                raise SieveError("sieve returned no api_key", payload=token)
            if status == 400 and isinstance(token, dict):
                error = token.get("error")
                if error == "authorization_pending":
                    sleep(interval)
                    continue
                if error == "slow_down":
                    interval += 5
                    sleep(interval)
                    continue
                if error == "access_denied":
                    raise DeviceLoginDenied("the device was not approved")
                if error == "expired_token":
                    break                                            # restart at step 1
                raise _error_for(status, headers_out, token)
            if 500 <= status < 600:
                sleep(RETRY_START)
                continue
            raise _error_for(status, headers_out, token)
        restarts += 1
        if restarts > max_restarts:
            raise DeviceLoginExpired("the device code expired; run the login again")
