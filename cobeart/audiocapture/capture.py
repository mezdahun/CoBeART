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

    def __init__(self, chunk_size=1024, sample_rate=48000, spectrum_bins=128, spectrum_history=16):
        """
        Initializes the AudioCapturer by selecting a device.
        A larger chunk_size (e.g., 1024) is better for frequency resolution of metrics.
        A smaller chunk_size (e.g., 512) is better for low-latency visualization.

        Args:
            chunk_size: Number of audio samples per chunk
            sample_rate: Audio sample rate in Hz
            spectrum_bins: Number of frequency bins for spectrum analysis
            spectrum_history: Number of historical spectrum frames to keep
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

        # Spectrum analysis configuration
        self.spectrum_bins = spectrum_bins
        self.spectrum_history = spectrum_history
        self.freq_min = 20.0  # Hz
        self.freq_max = 20000.0  # Hz

        # Pre-compute Hanning window for FFT
        self._window = np.hanning(chunk_size)

        # Spectrum history buffer (ring buffer)
        self._spectrum_buffer = np.zeros((spectrum_history, spectrum_bins), dtype=np.float32)
        self._spectrum_index = 0
        self._spectrum_lock = threading.Lock()

        # Smoothing factor for spectrum (attack/decay)
        self._spectrum_smoothing = 0.3
        self._last_spectrum = np.zeros(spectrum_bins, dtype=np.float32)

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

    def get_spectrum(self, data, update_history=True):
        """
        Compute FFT spectrum with logarithmically-spaced frequency bins.

        Args:
            data: Audio samples (numpy array)
            update_history: If True, adds this spectrum to history buffer

        Returns:
            numpy array of shape (spectrum_bins,) with normalized magnitudes [0.0, 1.0]
        """
        n = len(data)
        if n == 0:
            return np.zeros(self.spectrum_bins, dtype=np.float32)

        # Apply window and compute FFT
        windowed = data * self._window
        fft_result = np.fft.rfft(windowed)
        fft_freqs = np.fft.rfftfreq(n, 1.0 / self.sample_rate)
        fft_magnitudes = np.abs(fft_result)

        # Create logarithmically-spaced frequency bins (perceptually better)
        # This maps low frequencies to more bins (bass) and high frequencies to fewer bins (treble)
        log_freq_bins = np.logspace(
            np.log10(max(self.freq_min, 1.0)),
            np.log10(min(self.freq_max, self.sample_rate / 2)),
            self.spectrum_bins + 1
        )

        # Map FFT bins to our custom bins
        spectrum = np.zeros(self.spectrum_bins, dtype=np.float32)
        for i in range(self.spectrum_bins):
            # Find FFT bins within this frequency range
            freq_low = log_freq_bins[i]
            freq_high = log_freq_bins[i + 1]
            mask = (fft_freqs >= freq_low) & (fft_freqs < freq_high)

            if np.any(mask):
                # Average magnitude in this frequency band
                spectrum[i] = np.mean(fft_magnitudes[mask])

        # Normalize using log scale for better visual range
        # Add small epsilon to avoid log(0)
        spectrum = np.log10(spectrum + 1e-10)
        # Map to [0, 1] range (assuming typical audio range)
        spectrum = np.clip((spectrum + 10.0) / 10.0, 0.0, 1.0)

        # Apply temporal smoothing (attack/decay)
        alpha = self._spectrum_smoothing
        spectrum = alpha * spectrum + (1.0 - alpha) * self._last_spectrum
        self._last_spectrum = spectrum.copy()

        # Update history buffer
        if update_history:
            with self._spectrum_lock:
                self._spectrum_buffer[self._spectrum_index] = spectrum
                self._spectrum_index = (self._spectrum_index + 1) % self.spectrum_history

        return spectrum

    def get_spectrum_2d(self):
        """
        Get the 2D spectrum history buffer for use as a shader texture.

        Returns:
            numpy array of shape (spectrum_history, spectrum_bins) with values [0.0, 1.0]
            Rows are ordered from oldest (index 0) to newest (index -1)
        """
        with self._spectrum_lock:
            # Reorder buffer so oldest is first, newest is last
            # This creates the correct orientation for texture sampling
            buffer_copy = np.zeros_like(self._spectrum_buffer)
            for i in range(self.spectrum_history):
                src_idx = (self._spectrum_index + i) % self.spectrum_history
                buffer_copy[i] = self._spectrum_buffer[src_idx]
            return buffer_copy

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
