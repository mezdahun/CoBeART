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
        enable_beat_detection: bool = False,
        beat_debug: bool = False,
    ) -> None:
        self.socketio_url = socketio_url or get_socketio_url()
        self.namespace = namespace
        self.emit_interval_s = 1.0 / max(emit_hz, 1.0)
        self.capturer = AudioCapturer(
            chunk_size=chunk_size,
            enable_beat_detection=enable_beat_detection,
            debug=beat_debug
        )

        self._sio = socketio.Client(reconnection=True, reconnection_attempts=0)
        self._setup_handlers()

        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._connected = threading.Event()

    # ---- Socket.IO event handlers ----
    def _setup_handlers(self) -> None:
        @_event(self._sio, "connect", namespace=self.namespace)
        def _on_connect() -> None:
            self._connected.set()
            print(f"[audio] connected to {self.namespace}")

        @_event(self._sio, "disconnect", namespace=self.namespace)
        def _on_disconnect() -> None:
            self._connected.clear()
            print(f"[audio] disconnected from {self.namespace}")

        # Don't log connect_error - too noisy during reconnection attempts
        @_event(self._sio, "connect_error", namespace=self.namespace)
        def _on_connect_error(data) -> None:
            pass  # Silently ignore - reconnection will handle it

    # ---- Public API ----
    def start(self, timeout: float = 5.0) -> bool:
        """
        Start the audio emitter.

        Args:
            timeout: Maximum seconds to wait for initial connection

        Returns:
            True if connected, False if not connected (will retry in background)
        """
        if self._thread is not None:
            return self._connected.is_set()

        self._connect()

        # Wait for initial connection
        if self._connected.wait(timeout=timeout):
            # Connection message will be printed by _on_connect handler
            pass
        else:
            print(f"[audio] waiting for connection (will retry every 5s)...")

        self.capturer.start_stream()
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, name="audio-metrics-emitter", daemon=True)
        self._thread.start()

        return self._connected.is_set()

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
            # wait=False: return immediately, let connection happen in background
            self._sio.connect(
                self.socketio_url,
                transports=["websocket"],
                namespaces=namespaces,
                wait=False  # Don't wait - let it connect asynchronously
            )
        except Exception:
            pass  # Silently fail - reconnection loop will retry

    def _loop(self) -> None:
        next_time = time.time()
        last_status_log = time.time()
        last_reconnect_attempt = 0
        STATUS_LOG_INTERVAL = 30.0  # Log status every 30 seconds
        RECONNECT_INTERVAL = 5.0  # Try to reconnect every 5 seconds if not connected

        while not self._stop_event.is_set():
            # Try to reconnect if not connected and enough time has passed
            now = time.time()
            if not self._connected.is_set() and not self._sio.connected:
                if now - last_reconnect_attempt >= RECONNECT_INTERVAL:
                    self._connect()
                    last_reconnect_attempt = now

            self._emit_once()
            next_time += self.emit_interval_s
            delay = max(0.0, next_time - time.time())
            if delay > 0:
                time.sleep(delay)

            # Periodic status logging
            if now - last_status_log >= STATUS_LOG_INTERVAL:
                status = "connected" if self._connected.is_set() else "disconnected"
                print(f"[audio] status: {status}")
                last_status_log = now

    def _emit_once(self) -> None:
        # Only emit if connected
        if not self._connected.is_set():
            return

        data = self.capturer.read_chunk()
        if data is None or data.size == 0:
            return
        payload = self._compute_metrics_payload(data)
        if payload is None:
            return

        # Print metrics to terminal (carriage return for live updating)
        beat_indicator = "🥁 BEAT" if payload['beat'] else "     "
        peak_indicator = "📈 PEAK" if payload['is_peak'] else "      "
        onset_indicator = "⚡ ONSET" if payload['is_onset'] else "       "
        tempo_str = f"{payload['tempo_bpm']:.1f} BPM" if payload['tempo_bpm'] is not None else "--- BPM"

        print(
            f"[audio] RMS: {payload['rms']:.4f} | Env: {payload['rms_envelope']:.3f} | "
            f"Peak: {payload['peak']:.4f} | Freq: {payload['dominant_frequency']:.0f} Hz | "
            f"{beat_indicator} | {peak_indicator} | {onset_indicator} | {tempo_str}  ",
            end='\r'
        )

        try:
            self._sio.emit("audio_metrics", payload, namespace=self.namespace)
        except Exception as exc:
            print(f"\n[audio] emit failed: {exc}")  # Newline to avoid overwriting metrics

    def _compute_metrics_payload(self, data) -> Optional[Dict[str, Any]]:
        rms = float(self.capturer.get_rms(data))
        peak = float(self.capturer.get_peak_amplitude(data))
        zcr = float(self.capturer.get_zero_crossing_rate(data))
        dominant = float(self.capturer.get_dominant_frequency(data))

        # Advanced metrics
        rms_db = float(self.capturer.get_rms_db(data))
        rms_envelope = float(self.capturer.get_rms_envelope(rms_db))
        is_peak, peak_intensity = self.capturer.detect_rms_peak(rms)
        peak_intensity = float(peak_intensity)
        is_onset, onset_strength = self.capturer.detect_onset(data)
        onset_strength = float(onset_strength)

        # Compute spectrum and get 2D history buffer
        self.capturer.get_spectrum(data, update_history=True)
        spectrum_2d = self.capturer.get_spectrum_2d()

        # Check for beat detection
        beat, tempo_bpm, beat_timestamp = self.capturer.has_beat()

        payload = {
            "rms": rms,
            "peak": peak,
            "zcr": zcr,
            "dominant_frequency": dominant,
            "rms_db": rms_db,
            "rms_envelope": rms_envelope,
            "is_peak": is_peak,
            "peak_intensity": peak_intensity,
            "is_onset": is_onset,
            "onset_strength": onset_strength,
            "spectrum_2d": spectrum_2d.tolist(),  # Convert numpy array to list for JSON
            "spectrum_config": {
                "width": self.capturer.spectrum_bins,
                "height": self.capturer.spectrum_history,
                "freq_min": self.capturer.freq_min,
                "freq_max": self.capturer.freq_max,
            },
            "beat": beat,
            "tempo_bpm": tempo_bpm,
            "beat_timestamp": beat_timestamp,
        }

        return payload


def _event(sio_client: socketio.Client, name: str, namespace: str):
    def _decorator(func):
        return sio_client.on(name, namespace=namespace)(func)

    return _decorator


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="Emit audio metrics to Socket.IO server")
    parser.add_argument(
        "--enable-beat-detection",
        action="store_true",
        help="Enable real-time beat detection (requires madmom)"
    )
    args = parser.parse_args()

    emitter = AudioMetricsEmitter(enable_beat_detection=args.enable_beat_detection)
    emitter.start()

    if args.enable_beat_detection:
        print("Beat detection enabled - audio metrics will include beat flag and tempo")
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


