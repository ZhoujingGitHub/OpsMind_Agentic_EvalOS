#!/usr/bin/env python3
"""Bounded, secret-free access logging for the lab's fixed health endpoint."""
from __future__ import annotations

import datetime as dt
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ACCESS = logging.getLogger("mec.health")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path not in {"/", "/health"}:
            self.send_error(404)
            return
        payload = json.dumps({"service": "opsmind-protocol-lab-mec",
                              "status": "healthy", "protocol": "http"},
                             separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        delivered = False
        try:
            self.wfile.write(payload)
            delivered = True
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            ACCESS.info(json.dumps({"observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                                    "source_address": self.client_address[0],
                                    "method": "GET", "path": self.path,
                                    "status": 200, "write_completed": delivered},
                                   separators=(",", ":")))

    def log_message(self, format: str, *args: object) -> None:
        # No arbitrary URL, header, request body or credentials in access logs.
        del format, args


if __name__ == "__main__":
    handler = RotatingFileHandler("/var/log/opsmind-harness-mec-http.log",
                                  maxBytes=1024 * 1024, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(message)s"))
    ACCESS.addHandler(handler)
    ACCESS.setLevel(logging.INFO)
    network = json.loads(Path("/etc/opsmind-twin/stack.manifest.json").read_text())["harness_network"]
    ThreadingHTTPServer((network["mec_address"], network["http_port"]), Handler).serve_forever()
