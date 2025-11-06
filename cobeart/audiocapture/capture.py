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

    def __init__(self, chunk_size=1024, sample_rate=48000, spectrum_bins=128, spectrum_history=16, enable_beat_detection=False):
        """
        Initializes the AudioCapturer by selecting a device.
        A larger chunk_size (e.g., 1024) is better for frequency resolution of metrics.
        A smaller chunk_size (e.g., 512) is better for low-latency visualization.

        Args:
            chunk_size: Number of audio samples per chunk
            sample_rate: Audio sample rate in Hz
            spectrum_bins: Number of frequency bins for spectrum analysis
            spectrum_history: Number of historical spectrum frames to keep
            enable_beat_detection: Enable real-time beat detection (requires madmom)
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

        # Beat detection (optional)
        self.enable_beat_detection = enable_beat_detection
        self._beat_detector = None
        self._last_forwarded_beat_timestamp = None  # Track last beat timestamp sent to consumers
        self._current_tempo = None
        self._beat_lock = threading.Lock()
        self._beat_processing_thread = None

        # Test logging for has_beat() internal state (all timestamps absolute)
        self._has_beat_test_log = []  # Records (wall_time, latest_beat_time, last_forwarded, returned_beat)
        self._enable_has_beat_test = False

        # RMS envelope (dB-scaled with attack/decay smoothing)
        self._rms_db_envelope = 0.0
        self._envelope_attack = 0.7      # Fast attack coefficient (0.7 = ~230ms to 90%)
        self._envelope_release = 0.95    # Release coefficient (0.95 = ~1.5s to 10%)

        # Peak detection (historic RMS analysis)
        self._rms_history = []
        self._rms_history_size = 100     # ~3.3 seconds at 30Hz
        self._peak_threshold_multiplier = 2.0  # Increased from 1.5 for more selective peaks
        self._peak_minimum_rms = 0.1    # Absolute minimum RMS to register peaks (prevents noise)
        self._last_peak_time = 0
        self._peak_cooldown = 0.3        # 300ms minimum between peaks (was 0.1)

        # Onset detection (spectral flux with adaptive thresholding)
        self._last_spectrum_for_onset = None
        self._onset_flux_history = []
        self._onset_flux_history_size = 50      # ~1.7 seconds at 30Hz
        self._onset_threshold_multiplier = 2.5  # Must exceed 2.5x average flux
        self._onset_minimum_flux = 0.3          # Absolute minimum to prevent noise

        if self.enable_beat_detection:
            try:
                from cobeart.audiocapture.beatdetector import BeatDetector
                print("[audio] Initializing beat detection...")
                self._beat_detector = BeatDetector(
                    buffer_seconds=2,
                    capture_sample_rate=self.sample_rate,
                    debug=False
                )
                self._beat_detector.enable_logging()
                print("[audio] Beat detection enabled")
            except ImportError as e:
                print(f"[audio] Warning: Could not enable beat detection: {e}")
                self.enable_beat_detection = False

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

                        # Feed to beat detector if enabled
                        if self.enable_beat_detection and self._beat_detector is not None:
                            self._beat_detector.add_chunk(block[:n] if n < self.chunk_size else block[-self.chunk_size:])
            except Exception:
                pass

        self._capture_thread = threading.Thread(target=_capture_loop, name="audio-capture", daemon=True)
        self._capture_thread.start()

        # Start beat processing thread if enabled
        if self.enable_beat_detection and self._beat_detector is not None:
            def _beat_processing_loop():
                """Background thread that continuously processes beat detection."""
                while not self._stop_event.is_set():
                    # Check if processing is due
                    if self._beat_detector.should_process():
                        # Process beat detection (this takes ~169ms)
                        beat, tempo = self._beat_detector.process()

                        # Update shared state atomically
                        # Beat timestamps are tracked in beat_history - consumers pull from there
                        with self._beat_lock:
                            if tempo is not None:
                                self._current_tempo = tempo
                    else:
                        # Calculate exact sleep time until next processing window
                        sleep_time = max(0.001, self._beat_detector._next_process_time - time.time())
                        time.sleep(sleep_time)

            self._beat_processing_thread = threading.Thread(
                target=_beat_processing_loop,
                name="beat-processing",
                daemon=True
            )
            self._beat_processing_thread.start()
            print("[audio] Beat processing thread started")

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
        if self._beat_processing_thread is not None:
            self._beat_processing_thread.join(timeout=1.0)
            self._beat_processing_thread = None
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

    def get_rms_db(self, data, min_db=-60.0, max_db=0.0):
        """
        Get RMS in decibel scale, mapped to [0.0, 1.0].

        Args:
            data: Audio samples
            min_db: Silence threshold in dB (default -60)
            max_db: Maximum level in dB (default 0, full scale)

        Returns:
            Float in range [0.0, 1.0] with perceptually linear scaling
        """
        rms = self.get_rms(data)

        # Convert to dB (20*log10 for amplitude)
        # Add small epsilon to avoid log(0)
        rms_db = 20 * np.log10(max(rms, 1e-10))

        # Map to [0.0, 1.0] range
        normalized = (rms_db - min_db) / (max_db - min_db)
        return float(np.clip(normalized, 0.0, 1.0))

    def get_rms_envelope(self, current_rms_db):
        """
        Get smoothed RMS envelope with fast attack and slow decay.

        This creates a smooth, visually-pleasing envelope that follows
        increases quickly but decays slowly, ideal for audio-reactive visuals.

        Args:
            current_rms_db: Current dB-scaled RMS value [0.0, 1.0]

        Returns:
            Float representing smoothed energy level [0.0, 1.0]
        """
        if current_rms_db > self._rms_db_envelope:
            # Attack: follow increases quickly
            self._rms_db_envelope = (self._envelope_attack * self._rms_db_envelope +
                                      (1.0 - self._envelope_attack) * current_rms_db)
        else:
            # Release: blend slowly toward current value (not multiplicative decay)
            self._rms_db_envelope = (self._envelope_release * self._rms_db_envelope +
                                      (1.0 - self._envelope_release) * current_rms_db)

        return float(self._rms_db_envelope)

    def detect_rms_peak(self, current_rms):
        """
        Detect if current RMS represents a significant peak above recent history.

        Uses a dynamic threshold based on recent RMS average. Peaks are detected
        when current RMS exceeds both the dynamic threshold AND an absolute minimum,
        and enough time has passed since the last peak (cooldown period).

        Args:
            current_rms: Current raw RMS value (not dB-scaled)

        Returns:
            Tuple of (is_peak, peak_intensity)
            - is_peak: Boolean indicating if this is a peak moment
            - peak_intensity: Float indicating how much above threshold (0.0+)
        """
        current_time = time.time()

        # Add to history
        self._rms_history.append(current_rms)
        if len(self._rms_history) > self._rms_history_size:
            self._rms_history.pop(0)

        # Need some history to establish baseline
        if len(self._rms_history) < 10:
            return False, 0.0

        # Calculate dynamic threshold from recent history
        avg_rms = np.mean(self._rms_history)
        threshold = avg_rms * self._peak_threshold_multiplier

        # Check if current RMS exceeds threshold, minimum absolute level, and cooldown
        is_peak = (current_rms > threshold and
                   current_rms > self._peak_minimum_rms and
                   current_time - self._last_peak_time > self._peak_cooldown)

        if is_peak:
            self._last_peak_time = current_time

        # Calculate intensity (how much above threshold)
        peak_intensity = max(0.0, (current_rms - threshold) / (threshold + 1e-6))

        return is_peak, float(peak_intensity)

    def detect_onset(self, data):
        """
        Detect audio onsets using adaptive spectral flux analysis.

        Onsets are detected by analyzing sudden increases in spectral energy
        relative to recent history. This adaptive approach works across different
        dynamics levels in music.

        Args:
            data: Audio samples (numpy array)

        Returns:
            Tuple of (is_onset, onset_strength)
            - is_onset: Boolean indicating if an onset was detected
            - onset_strength: Float indicating onset magnitude relative to threshold
        """
        # Get current spectrum (don't update history to avoid side effects)
        current_spectrum = self.get_spectrum(data, update_history=False)

        # Need previous spectrum for comparison
        if self._last_spectrum_for_onset is None:
            self._last_spectrum_for_onset = current_spectrum
            return False, 0.0

        # Calculate spectral flux (half-wave rectified)
        # Only count increases in energy (positive differences)
        flux = np.sum(np.maximum(0, current_spectrum - self._last_spectrum_for_onset))

        # Update stored spectrum for next comparison
        self._last_spectrum_for_onset = current_spectrum.copy()

        # Add to history for adaptive threshold
        self._onset_flux_history.append(flux)
        if len(self._onset_flux_history) > self._onset_flux_history_size:
            self._onset_flux_history.pop(0)

        # Need some history to establish baseline
        if len(self._onset_flux_history) < 10:
            return False, 0.0

        # Calculate dynamic threshold from recent history
        avg_flux = np.mean(self._onset_flux_history)
        threshold = avg_flux * self._onset_threshold_multiplier

        # Detect onset: must exceed both dynamic threshold AND absolute minimum
        is_onset = (flux > threshold and flux > self._onset_minimum_flux)

        # Calculate strength relative to threshold
        onset_strength = min(flux / max(threshold, 0.1), 5.0)  # Cap at 5x

        return is_onset, float(onset_strength)

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

    def enable_has_beat_test(self):
        """Enable test logging for has_beat() internal state."""
        self._enable_has_beat_test = True
        self._has_beat_test_log = []

    def save_has_beat_test(self, filepath):
        """Save has_beat() test log to file."""
        with open(filepath, 'w') as f:
            f.write("# has_beat() internal state log\n")
            f.write("# Format: wall_time(absolute), latest_beat_time(absolute), last_forwarded_time(absolute), returned_beat(bool)\n")
            for wall_time, latest, last_fwd, result in self._has_beat_test_log:
                last_fwd_str = f"{last_fwd:.6f}" if last_fwd is not None else "None"
                f.write(f"{wall_time:.6f}, {latest:.6f}, {last_fwd_str}, {result}\n")

    def has_beat(self):
        """
        Check if a beat was detected and get current tempo.

        This method is non-blocking and returns immediately. Beat processing
        happens in a background thread.

        Returns True only once per unique beat timestamp. Multiple calls
        between beats return False.

        Returns:
            Tuple of (beat_detected, tempo_bpm)
            - beat_detected: True only for first call after a new beat is detected
            - tempo_bpm: Current tempo estimate (None if not yet determined)
        """
        if not self.enable_beat_detection or self._beat_detector is None:
            return False, None

        with self._beat_lock:
            # Get latest beat timestamp from detector's history
            if len(self._beat_detector._beat_history) == 0:
                return False, self._current_tempo

            latest_beat_time = self._beat_detector._beat_history[-1]

            # Check if this is a new beat we haven't forwarded yet
            is_new = self._last_forwarded_beat_timestamp is None or latest_beat_time != self._last_forwarded_beat_timestamp

            # TEST LOGGING: Record internal state with absolute timestamps
            if self._enable_has_beat_test:
                wall_time = time.time()  # Absolute timestamp
                self._has_beat_test_log.append((
                    wall_time,
                    latest_beat_time,
                    self._last_forwarded_beat_timestamp,
                    is_new
                ))

            if is_new:
                self._last_forwarded_beat_timestamp = latest_beat_time
                return True, self._current_tempo

            # Same beat as last time - already forwarded
            return False, self._current_tempo

def main():
    """Main function to test audio capture and metrics."""
    import argparse
    parser = argparse.ArgumentParser(description="Capture and display audio metrics")
    parser.add_argument(
        "--enable-beat-detection",
        action="store_true",
        help="Enable real-time beat detection (requires madmom)"
    )
    args = parser.parse_args()

    # Use 1024 as the default for metrics to get better frequency resolution.
    capturer = AudioCapturer(
        chunk_size=1024,
        enable_beat_detection=args.enable_beat_detection
    )
    capturer.start_stream()

    if args.enable_beat_detection:
        print("Beat detection enabled")
    print("Reading audio metrics... Press Ctrl+C to stop.")

    try:
        while True:
            audio_data = capturer.read_chunk()
            if audio_data is not None and audio_data.size > 0:
                rms = capturer.get_rms(audio_data)
                peak = capturer.get_peak_amplitude(audio_data)
                zcr = capturer.get_zero_crossing_rate(audio_data)
                dom_freq = capturer.get_dominant_frequency(audio_data)

                # Check for beat if enabled
                if args.enable_beat_detection:
                    beat, tempo_bpm = capturer.has_beat()
                    beat_indicator = "🥁 BEAT" if beat else "     "
                    tempo_str = f"{tempo_bpm:.1f} BPM" if tempo_bpm is not None else "--- BPM"
                    print(
                        f"RMS: {rms:.4f} | Peak: {peak:.4f} | ZCR: {zcr:.4f} | "
                        f"Freq: {dom_freq:.0f} Hz | {beat_indicator} | {tempo_str}  ",
                        end='\r'
                    )
                else:
                    # Use carriage return to print on the same line for a cleaner output
                    print(
                        f"RMS: {rms:.4f} | Peak: {peak:.4f} | ZCR: {zcr:.4f} | "
                        f"Dominant Freq: {dom_freq:.2f} Hz  ",
                        end='\r'
                    )

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
