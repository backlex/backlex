"""SSE realtime transport.

The backlex realtime plane is Server-Sent Events (not WebSockets), so this is a
minimal SSE reader running on a daemon thread. ``subscribe`` returns an
``unsubscribe`` callable — the same ``() -> None`` contract as the TS SDK. The
reader auto-reconnects on a dropped stream (3s back-off, matching the server's
reconnect hint) and replays via ``Last-Event-ID`` when the server supplies ids.
"""

from __future__ import annotations

import json
import threading
from typing import Any, Callable, Dict, Optional

import httpx

from .errors import BacklexError
from .types import ItemEvent

OnEvent = Callable[[ItemEvent], None]
OnError = Callable[[Any], None]
Unsubscribe = Callable[[], None]

_RECONNECT_SECONDS = 3.0


def subscribe(
    http: httpx.Client,
    url: str,
    auth_header: Callable[[], Dict[str, str]],
    on_event: OnEvent,
    on_error: Optional[OnError] = None,
) -> Unsubscribe:
    stop = threading.Event()

    def run() -> None:
        last_id: Optional[str] = None
        while not stop.is_set():
            headers = {"accept": "text/event-stream", **auth_header()}
            if last_id is not None:
                headers["last-event-id"] = last_id
            try:
                with http.stream("GET", url, headers=headers, timeout=None) as resp:
                    if resp.status_code != 200:
                        raise BacklexError(resp.status_code, None)
                    data_lines: list[str] = []
                    for line in resp.iter_lines():
                        if stop.is_set():
                            return
                        if line == "":
                            # Blank line dispatches the buffered event.
                            if data_lines:
                                payload = "\n".join(data_lines)
                                data_lines = []
                                try:
                                    on_event(json.loads(payload))
                                except Exception as exc:  # noqa: BLE001
                                    if on_error:
                                        on_error(exc)
                            continue
                        if line.startswith(":"):
                            # Comment / heartbeat frame.
                            continue
                        if line.startswith("id:"):
                            last_id = line[3:].strip()
                            continue
                        if line.startswith("data:"):
                            data_lines.append(line[5:].lstrip())
            except Exception as exc:  # noqa: BLE001
                if stop.is_set():
                    return
                if on_error:
                    on_error(exc)
            # Reconnect after a short back-off unless we've been told to stop.
            stop.wait(_RECONNECT_SECONDS)

    thread = threading.Thread(target=run, name=f"backlex-sse:{url}", daemon=True)
    thread.start()

    def unsubscribe() -> None:
        stop.set()

    return unsubscribe
