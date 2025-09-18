import numpy as np
import soundcard as sc
import warnings
import time
import threading
from cobeart.audiocapture.utils import select_audio_device

# NumPy 2.x compatibility for soundcard backend: redirect deprecated binary fromstring to frombuffer
try:
    import soundcard.mediafoundation as _sc_mf  # type: ignore
    _sc_mf.numpy.fromstring = np.frombuffer  # type: ignore[attr-defined]
except Exception:
    pass

class AudioCapturer:
    """A class to capture audio from a user-selected input device."""

    def __init__(self, chunk_size=1024, sample_rate=48000):
        """
        Initializes the AudioCapturer by selecting a device.
        A larger chunk_size (e.g., 1024) is better for frequency resolution of metrics.
        A smaller chunk_size (e.g., 512) is better for low-latency visualization.
        """
        self.mic = select_audio_device()
        self.chunk_size = chunk_size
        # Prefer device default samplerate if available to avoid resampling.
        try:
            self.sample_rate = sc.default_samplerate()
        except Exception:
            self.sample_rate = sample_rate
        self.is_recording = False
        # Threaded capture state
        self._stop_event = threading.Event()
        self._ring = np.zeros(self.chunk_size, dtype=np.float32)
        self._ring_lock = threading.Lock()
        self._capture_thread = None

    def start_stream(self):
        """Starts the audio recording stream."""
        if self.is_recording:
            print("Stream is already running.")
            return
        
        print("Audio stream started.")
        # Reduce warning spam for occasional glitches from the backend.
        warnings.filterwarnings(
            "once",
            message="data discontinuity in recording",
            module="soundcard.mediafoundation",
        )
        # Capture in ~10 ms blocks for stability; maintain a rolling window of chunk_size
        base10 = int(round(self.sample_rate / 100))  # ~10 ms
        capture_frames = max(base10, 240)
        self._stop_event.clear()

        def _capture_loop():
            try:
                with self.mic.recorder(
                    samplerate=self.sample_rate, channels=[0], blocksize=capture_frames
                ) as recorder:
                    while not self._stop_event.is_set():
                        data = recorder.record(numframes=capture_frames)
                        if data is None:
                            continue
                        block = data.reshape(-1)
                        with self._ring_lock:
                            n = min(len(block), self.chunk_size)
                            if n < self.chunk_size:
                                self._ring[:-n] = self._ring[n:]
                                self._ring[-n:] = block[:n]
                            else:
                                self._ring[:] = block[-self.chunk_size:]
            except Exception:
                pass

        self._capture_thread = threading.Thread(target=_capture_loop, name="audio-capture", daemon=True)
        self._capture_thread.start()
        self.is_recording = True

    def stop_stream(self):
        """Stops the audio recording stream."""
        if not self.is_recording:
            print("Stream is not running.")
            return

        self._stop_event.set()
        if self._capture_thread is not None:
            self._capture_thread.join(timeout=1.0)
            self._capture_thread = None
        self.is_recording = False
        print("Audio stream stopped.")

    def read_chunk(self):
        """Reads a chunk of audio data from the stream."""
        if not self.is_recording:
            return None
        with self._ring_lock:
            return self._ring.copy()

    def get_rms(self, data):
        """Calculates the RMS of a chunk of audio data."""
        return np.sqrt(np.mean(data**2))

    def get_peak_amplitude(self, data):
        """Gets the peak amplitude of a chunk of audio data."""
        return np.max(np.abs(data))

    def get_zero_crossing_rate(self, data):
        """Calculates the zero-crossing rate of a chunk of audio data."""
        # Count sign changes; avoid division by zero on empty input
        if len(data) == 0:
            return 0.0
        return float(np.count_nonzero(np.diff(np.signbit(data)))) / float(len(data))

    def get_dominant_frequency(self, data):
        """Calculates the dominant frequency of a chunk of audio data using FFT."""
        n = len(data)
        if n == 0:
            return 0.0
        window = np.hanning(n)
        spectrum = np.fft.rfft(data * window)
        freqs = np.fft.rfftfreq(n, 1.0 / self.sample_rate)
        magnitudes = np.abs(spectrum)
        if magnitudes.size == 0:
            return 0.0
        peak_index = int(np.argmax(magnitudes))
        return float(freqs[peak_index])

def main():
    """Main function to test audio capture and metrics."""
    # Use 1024 as the default for metrics to get better frequency resolution.
    capturer = AudioCapturer(chunk_size=1024)
    capturer.start_stream()

    print("Reading audio metrics... Press Ctrl+C to stop.")

    try:
        while True:
            audio_data = capturer.read_chunk()
            if audio_data is not None and audio_data.size > 0:
                rms = capturer.get_rms(audio_data)
                peak = capturer.get_peak_amplitude(audio_data)
                zcr = capturer.get_zero_crossing_rate(audio_data)
                dom_freq = capturer.get_dominant_frequency(audio_data)

                # Use carriage return to print on the same line for a cleaner output
                print(f"RMS: {rms:.4f} | Peak: {peak:.4f} | ZCR: {zcr:.4f} | Dominant Freq: {dom_freq:.2f} Hz  ", end='\r')
            
            # Sleep for a duration that is close to the chunk's duration
            # This prevents a busy-wait loop from consuming 100% CPU.
            # Chunk duration = chunk_size / sample_rate = 1024 / 48000 ~= 0.021s
            time.sleep(0.02)
    except KeyboardInterrupt:
        # Print a newline to move off the updating line of metrics
        print("\nStopping metric capture.")
    finally:
        capturer.stop_stream()

if __name__ == "__main__":
    main()
