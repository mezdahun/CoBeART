import time
import threading
from typing import Optional, Dict, Any

import socketio  # python-socketio

from cobeart.audiocapture.capture import AudioCapturer
from cobeart.audiocapture.utils import get_socketio_url


class AudioMetricsEmitter:
    """
    Captures audio locally and emits derived metrics to a Socket.IO namespace.

    Metrics sent under event name 'audio_metrics':
      - rms: float
      - peak: float
      - zcr: float
      - dominant_frequency: float
    """

    def __init__(
        self,
        socketio_url: Optional[str] = None,
        namespace: str = "/audio",
        emit_hz: float = 30.0,
        chunk_size: int = 1024,
    ) -> None:
        self.socketio_url = socketio_url or get_socketio_url()
        self.namespace = namespace
        self.emit_interval_s = 1.0 / max(emit_hz, 1.0)
        self.capturer = AudioCapturer(chunk_size=chunk_size)

        self._sio = socketio.Client(reconnection=True, reconnection_attempts=0)
        self._setup_handlers()

        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ---- Socket.IO event handlers ----
    def _setup_handlers(self) -> None:
        @_event(self._sio, "connect", namespace=self.namespace)
        def _on_connect() -> None:
            print(f"[audio] connected to {self.namespace} at {self.socketio_url}")

        @_event(self._sio, "disconnect", namespace=self.namespace)
        def _on_disconnect() -> None:
            print(f"[audio] disconnected from {self.namespace}")

    # ---- Public API ----
    def start(self) -> None:
        if self._thread is not None:
            return
        self._connect()
        self.capturer.start_stream()
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, name="audio-metrics-emitter", daemon=True)
        self._thread.start()
        print("[audio] emitter started")

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=1.5)
            self._thread = None
        self.capturer.stop_stream()
        try:
            self._sio.disconnect()
        except Exception:
            pass
        print("[audio] emitter stopped")

    # ---- Internal helpers ----
    def _connect(self) -> None:
        namespaces = [self.namespace]
        try:
            self._sio.connect(self.socketio_url, transports=["websocket"], namespaces=namespaces)
        except Exception as exc:
            print(f"[audio] connect failed: {exc}")

    def _loop(self) -> None:
        next_time = time.time()
        while not self._stop_event.is_set():
            self._emit_once()
            next_time += self.emit_interval_s
            delay = max(0.0, next_time - time.time())
            if delay > 0:
                time.sleep(delay)

    def _emit_once(self) -> None:
        data = self.capturer.read_chunk()
        if data is None or data.size == 0:
            return
        payload = self._compute_metrics_payload()
        if payload is None:
            return
        try:
            self._sio.emit("audio_metrics", payload, namespace=self.namespace)
        except Exception as exc:
            print(f"[audio] emit failed: {exc}")

    def _compute_metrics_payload(self) -> Optional[Dict[str, Any]]:
        data = self.capturer.read_chunk()
        if data is None or data.size == 0:
            return None
        rms = float(self.capturer.get_rms(data))
        peak = float(self.capturer.get_peak_amplitude(data))
        zcr = float(self.capturer.get_zero_crossing_rate(data))
        dominant = float(self.capturer.get_dominant_frequency(data))
        return {
            "rms": rms,
            "peak": peak,
            "zcr": zcr,
            "dominant_frequency": dominant,
        }


def _event(sio_client: socketio.Client, name: str, namespace: str):
    def _decorator(func):
        return sio_client.event(func, namespace=namespace)

    return _decorator


def main() -> None:
    emitter = AudioMetricsEmitter()
    emitter.start()
    print("Press Ctrl+C to stop audio emission…")
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        pass
    finally:
        emitter.stop()


if __name__ == "__main__":
    main()


