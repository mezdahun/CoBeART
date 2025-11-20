import time
import threading
from typing import Optional, Dict, Any

import socketio

from cobeart.audiocapture.utils import get_socketio_url


class AudioEmitter:
    """
    Thin Socket.IO wrapper that immediately emits received metrics.

    No buffering, no rate limiting - pure pass-through from AudioCapturer to Socket.IO.
    """

    def __init__(
        self,
        socketio_url: Optional[str] = None,
        namespace: str = "/audio",
    ) -> None:
        self.socketio_url = socketio_url or get_socketio_url()
        self.namespace = namespace

        self._sio = socketio.Client(reconnection=True, reconnection_attempts=0)
        self._setup_handlers()

        self._connected = threading.Event()
        self._reconnect_thread = None
        self._stop_event = threading.Event()

        # Start connection
        self._connect()
        self._start_reconnect_loop()

    def _setup_handlers(self) -> None:
        """Setup Socket.IO event handlers."""
        @self._sio.on("connect", namespace=self.namespace)
        def _on_connect() -> None:
            self._connected.set()
            print(f"[audio] connected to {self.namespace}")

        @self._sio.on("disconnect", namespace=self.namespace)
        def _on_disconnect() -> None:
            self._connected.clear()
            print(f"[audio] disconnected from {self.namespace}")

        @self._sio.on("connect_error", namespace=self.namespace)
        def _on_connect_error(data) -> None:
            pass  # Silently ignore - reconnection will handle it

    def _connect(self) -> None:
        """Attempt to connect to Socket.IO server."""
        try:
            self._sio.connect(
                self.socketio_url,
                transports=["websocket"],
                namespaces=[self.namespace],
                wait=False
            )
        except Exception:
            pass  # Reconnection loop will retry

    def _start_reconnect_loop(self) -> None:
        """Start background thread to handle reconnection."""
        def _reconnect_loop():
            RECONNECT_INTERVAL = 5.0
            last_attempt = 0

            while not self._stop_event.is_set():
                now = time.time()
                if not self._connected.is_set() and not self._sio.connected:
                    if now - last_attempt >= RECONNECT_INTERVAL:
                        self._connect()
                        last_attempt = now
                time.sleep(1.0)

        self._reconnect_thread = threading.Thread(
            target=_reconnect_loop,
            name="audio-emitter-reconnect",
            daemon=True
        )
        self._reconnect_thread.start()

    def is_connected(self) -> bool:
        """
        Check if the emitter is currently connected to the Socket.IO server.

        Returns:
            True if connected, False otherwise
        """
        return self._connected.is_set() and self._sio.connected

    def push_metrics(self, payload: Dict[str, Any]) -> None:
        """
        Immediately emit metrics to Socket.IO (no buffering, no rate limiting).

        Args:
            payload: Dictionary with all computed audio metrics
        """
        if not self._connected.is_set():
            return

        try:
            self._sio.emit("audio_metrics", payload, namespace=self.namespace)
        except Exception:
            # Silently ignore emission failures to avoid spam at high frequency
            pass

    def stop(self) -> None:
        """Stop the emitter and disconnect from server."""
        self._stop_event.set()
        if self._reconnect_thread is not None:
            self._reconnect_thread.join(timeout=1.0)
        try:
            self._sio.disconnect()
        except Exception:
            pass
        print("[audio] emitter stopped")
