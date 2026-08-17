#!/usr/bin/env python3
"""Return success only when DNS crosses the UERANSIM UE tunnel."""

import socket
import struct


transaction = 0x4F50
labels = [b"evalos", b"test"]
query = struct.pack("!HHHHHH", transaction, 0x0100, 1, 0, 0, 0)
query += b"".join(bytes([len(label)]) + label for label in labels) + b"\x00\x00\x01\x00\x01"
probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
probe.settimeout(3)
probe.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, b"uesimtun0\x00")
probe.sendto(query, ("10.46.0.53", 53))
response, _ = probe.recvfrom(2048)
raise SystemExit(0 if len(response) >= 12 and struct.unpack("!H", response[:2])[0] == transaction else 1)
