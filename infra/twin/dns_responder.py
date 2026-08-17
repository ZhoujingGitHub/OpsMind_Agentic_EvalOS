#!/usr/bin/env python3
"""Tiny deterministic DNS responder for the isolated M2 data network."""

import socket
import struct


def main() -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("10.46.0.53", 53))
    while True:
        query, peer = server.recvfrom(2048)
        if len(query) < 12:
            continue
        offset = 12
        while offset < len(query) and query[offset] != 0:
            offset += query[offset] + 1
        question_end = min(offset + 5, len(query))
        header = query[:2] + struct.pack("!HHHHH", 0x8180, 1, 1, 0, 0)
        answer = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + socket.inet_aton("10.46.0.53")
        server.sendto(header + query[12:question_end] + answer, peer)


if __name__ == "__main__":
    main()
