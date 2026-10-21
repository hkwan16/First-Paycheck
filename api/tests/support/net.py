"""Helpers for tests that start a real server process."""

from __future__ import annotations

import socket


def free_port() -> int:
    """A TCP port on localhost that nothing is listening on right now."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port
