#!/usr/bin/env python3
"""Outbound-only EvalOS candidate relay worker.

This is transport infrastructure. It never implements candidate reasoning,
chooses tools, changes a score, or stores product credentials in EvalOS.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import ssl
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


PATHS = {
    "agent-harness-v2": [
        r"^/v2/auth/me$", r"^/v2/evaluation/controlled-remediation-contract$", r"^/v2/investigation-runtime$",
        r"^/v2/remediation/context$", r"^/v2/remediation/mode$", r"^/v2/investigation-candidates$",
        r"^/v2/investigations/[A-Za-z0-9_-]+$", r"^/v2/investigations/[A-Za-z0-9_-]+/execution-log(?:\?.*)?$",
        r"^/v2/actions(?:\?.*)?$", r"^/v2/evaluation/actions/[A-Za-z0-9_-]+$", r"^/v2/actions/[A-Za-z0-9_-]+/approval$",
    ],
    "langgraph-v1": [
        r"^/api/v1/me$", r"^/health/ready$", r"^/api/v1/automation/overview$", r"^/api/v1/automation/mode$",
        r"^/api/v1/candidates$", r"^/api/v1/investigations/[A-Za-z0-9_-]+$",
        r"^/api/v1/investigations/[A-Za-z0-9_-]+/journal(?:\?.*)?$",
        r"^/api/v1/investigations/[A-Za-z0-9_-]+/product-e2e$", r"^/api/v1/investigations/[A-Za-z0-9_-]+/approvals$",
    ],
}

ROLES = {"candidate_submitter", "approval_oracle", "mode_administrator"}


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class Worker:
    def __init__(self) -> None:
        self.candidate_ref = required("EVALOS_RELAY_CANDIDATE_REF")
        if self.candidate_ref not in PATHS:
            raise RuntimeError("unsupported candidate reference")
        self.worker_id = required("EVALOS_RELAY_WORKER_ID")
        self.evalos_origin = required("EVALOS_RELAY_ORIGIN").rstrip("/")
        self.product_origin = required("EVALOS_RELAY_PRODUCT_ORIGIN").rstrip("/")
        self.private_key = Path(required("EVALOS_RELAY_PRIVATE_KEY_FILE"))
        self.token_dir = Path(required("EVALOS_RELAY_TOKEN_DIR"))
        self.poll_seconds = float(os.environ.get("EVALOS_RELAY_POLL_SECONDS", "0.5"))
        self._validate_origin(self.evalos_origin, public=True)
        self._validate_origin(self.product_origin, public=False)
        if not self.private_key.is_file():
            raise RuntimeError("relay signing key file is missing")
        for role in ROLES:
            token_file = self.token_dir / role
            if not token_file.is_file():
                raise RuntimeError(f"candidate identity token file is missing for {role}")

    @staticmethod
    def _validate_origin(origin: str, *, public: bool) -> None:
        parsed = urlsplit(origin)
        if public and parsed.scheme != "https":
            raise RuntimeError("EvalOS relay origin must use HTTPS")
        if not public and (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}):
            raise RuntimeError("candidate product origin must be an HTTP loopback address")
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise RuntimeError("relay origins may not contain a path, query, or fragment")

    def _sign(self, pathname: str, raw_body: bytes) -> dict[str, str]:
        timestamp = str(int(time.time() * 1000))
        nonce = secrets.token_hex(16)
        body_hash = hashlib.sha256(raw_body).hexdigest()
        canonical = f"POST\n{pathname}\n{timestamp}\n{nonce}\n{body_hash}".encode("utf-8")
        # OpenSSL implements Ed25519 as a one-shot operation.  Feeding the
        # message through an anonymous pipe makes its size unknowable and
        # fails on Ubuntu's OpenSSL 3 with
        # ``unable to determine file size for oneshot operation``.  A private
        # temporary file gives OpenSSL a bounded input without persisting
        # request bodies or credentials in the relay installation.
        with tempfile.NamedTemporaryFile(prefix="evalos-relay-sign-", mode="w+b") as canonical_file:
            canonical_file.write(canonical)
            canonical_file.flush()
            result = subprocess.run(
                [
                    "/usr/bin/openssl", "pkeyutl", "-sign", "-rawin",
                    "-inkey", str(self.private_key), "-in", canonical_file.name,
                ],
                capture_output=True,
                check=False,
            )
        if result.returncode != 0:
            raise RuntimeError("relay request signing failed")
        import base64
        return {
            "x-evalos-relay-timestamp": timestamp,
            "x-evalos-relay-nonce": nonce,
            "x-evalos-relay-signature": base64.b64encode(result.stdout).decode("ascii"),
        }

    def _relay_post(self, pathname: str, body: dict) -> dict:
        raw = json_bytes(body)
        headers = {"content-type": "application/json", "accept": "application/json", **self._sign(pathname, raw)}
        request = Request(f"{self.evalos_origin}{pathname}", data=raw, method="POST", headers=headers)
        with urlopen(request, timeout=20, context=ssl.create_default_context()) as response:
            return json.loads(response.read().decode("utf-8") or "{}")

    def _product_call(self, item: dict) -> tuple[int, object]:
        role = item.get("credential_role")
        pathname = item.get("pathname", "")
        method = str(item.get("method", "GET")).upper()
        if role not in ROLES or method not in {"GET", "POST", "PUT"}:
            raise RuntimeError("relay request contains an unsupported role or method")
        parsed = urlsplit(pathname)
        if parsed.scheme or parsed.netloc or not pathname.startswith("/") or ".." in pathname or "\\" in pathname:
            raise RuntimeError("relay request path is unsafe")
        if not any(re.fullmatch(pattern, pathname) for pattern in PATHS[self.candidate_ref]):
            raise RuntimeError("relay request path is outside the product allowlist")
        token = (self.token_dir / role).read_text(encoding="utf-8").strip()
        if not token:
            raise RuntimeError("candidate identity token is empty")
        headers = {"accept": "application/json", "authorization": f"Bearer {token}"}
        tenant = (item.get("headers") or {}).get("x-tenant-id")
        if tenant:
            headers["x-tenant-id"] = str(tenant)
        body = item.get("body")
        raw = None if body is None else json_bytes(body)
        if raw is not None:
            headers["content-type"] = "application/json"
        request = Request(f"{self.product_origin}{pathname}", data=raw, method=method, headers=headers)
        try:
            with urlopen(request, timeout=45) as response:
                status = response.status
                response_raw = response.read()
        except HTTPError as error:
            status = error.code
            response_raw = error.read()
        try:
            payload = json.loads(response_raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError(f"candidate product returned non-JSON HTTP {status}") from error
        return status, payload

    def once(self) -> bool:
        claim_path = f"/api/candidate-relay/{self.candidate_ref}/claim"
        envelope = self._relay_post(claim_path, {"worker_id": self.worker_id, "lease_ms": 60000})
        item = envelope.get("request")
        if not item:
            return False
        complete_path = f"/api/candidate-relay/{self.candidate_ref}/requests/{item['id']}/complete"
        try:
            status, payload = self._product_call(item)
            completion = {"worker_id": self.worker_id, "response_status": status, "response_body": payload}
        except Exception as error:  # transport error is evidence; never include secrets or request bodies
            completion = {"worker_id": self.worker_id, "error": f"product transport failed: {type(error).__name__}: {error}"}
        self._relay_post(complete_path, completion)
        print(f"candidate_relay completed candidate={self.candidate_ref} request={item['id']}", flush=True)
        return True

    def run(self) -> None:
        print(f"candidate_relay started candidate={self.candidate_ref} worker={self.worker_id}", flush=True)
        while True:
            try:
                if not self.once():
                    time.sleep(self.poll_seconds)
            except (HTTPError, URLError, TimeoutError, RuntimeError) as error:
                print(f"candidate_relay retry candidate={self.candidate_ref} error={type(error).__name__}", file=sys.stderr, flush=True)
                time.sleep(min(max(self.poll_seconds, 1.0), 5.0))


if __name__ == "__main__":
    Worker().run()
