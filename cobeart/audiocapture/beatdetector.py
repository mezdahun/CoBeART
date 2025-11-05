import time
import numpy as np
import threading
from collections import deque
from typing import Tuple, Optional
from scipy.signal import resample


class BeatDetector:
    """
    Real-time beat detection using madmom library.

    Uses a 2.0s sliding window with dynamic tempo-driven processing intervals
    and refractory period optimization for efficient CPU usage.

    See BEAT_DETECTION.md for architectural details and rationale.
    """

    def __init__(
        self,
        buffer_seconds: float = 2,
        capture_sample_rate: int = 48000,
        madmom_sample_rate: int = 44100,
        min_interval_seconds: float = 0.170,
        min_beat_interval: float = 0.2,
        activation_threshold: float = 0.3,
        debug: bool = False
    ):
        """
        Initialize beat detector.

        Args:
            buffer_seconds: Size of rolling buffer (default 2.0s)
            capture_sample_rate: Sample rate of captured audio (default 48kHz)
            madmom_sample_rate: Sample rate expected by madmom (default 44.1kHz)
            min_interval_seconds: Minimum time between processing calls (default 170ms)
            min_beat_interval: Minimum time between beats to prevent duplicates (default 200ms)
            activation_threshold: Minimum activation level to consider beat section (default 0.3)
            debug: Enable debug logging (default False)
        """
        self.debug = debug
        # Import madmom here to make it an optional dependency
        try:
            from madmom.features.beats import RNNBeatProcessor, DBNBeatTrackingProcessor
        except ImportError:
            raise ImportError(
                "madmom library is required for beat detection. "
                "Install from source: https://github.com/CPJKU/madmom"
            )

        self.buffer_seconds = buffer_seconds
        self.capture_sample_rate = capture_sample_rate
        self.madmom_sample_rate = madmom_sample_rate
        self.min_interval_seconds = min_interval_seconds
        self.min_beat_interval = min_beat_interval
        self.activation_threshold = activation_threshold

        # Calculate buffer sizes
        self.buffer_samples_capture = int(buffer_seconds * capture_sample_rate)
        self.buffer_samples_madmom = int(buffer_seconds * madmom_sample_rate)

        # Rolling buffer (at capture sample rate)
        self._buffer = deque(maxlen=self.buffer_samples_capture)
        self._buffer_lock = threading.Lock()

        # Initialize madmom processors (online mode for lower latency)
        print("[beat] Initializing madmom processors (this may take a moment)...")
        self._beat_proc = RNNBeatProcessor(online=True)
        self._track_proc = DBNBeatTrackingProcessor(fps=100, online=True)
        print("[beat] Processors initialized")

        # State tracking
        self._last_reported_beat = -999.0  # Time of last reported beat
        self._estimated_bpm = None  # Current tempo estimate
        self._next_process_time = 0.0  # When to next process buffer
        self._processing_start_time = time.time()  # Anchor for timing

        # Beat history for BPM calculation (time-based expiry: 2.0s window)
        self._beat_history = deque()  # Beats from last 2 seconds (cleaned in process())
        self._new_region_duration = 0.5  # Only look at last 0.5s of buffer for new beats

        # Lockup prevention: track consecutive rejections
        self._consecutive_rejections = 0
        self._max_consecutive_rejections = 10  # Force accept after 10 rejections (~2-4 seconds)

        # Beat timestamp logger (optional, for analysis)
        self._beat_logger = None

    def add_chunk(self, chunk: np.ndarray) -> None:
        """
        Add audio chunk to rolling buffer.

        Args:
            chunk: Audio samples (mono, float32)
        """
        with self._buffer_lock:
            self._buffer.extend(chunk)

    def enable_logging(self, log_dir: str = ".") -> None:
        """
        Enable beat timestamp logging to file for analysis.

        Args:
            log_dir: Directory to write log file (default: current directory)
        """
        from cobeart.audiocapture.beat_logger import BeatLogger
        self._beat_logger = BeatLogger(enabled=True, log_dir=log_dir)

    def should_process(self) -> bool:
        """
        Check if enough time has elapsed to process beat detection.

        Returns:
            True if processing is due, False otherwise
        """
        current_time = time.time() - self._processing_start_time
        return current_time >= self._next_process_time

    def process(self) -> Tuple[bool, Optional[float]]:
        """
        Process buffer for beat detection.

        Returns:
            Tuple of (beat_detected, tempo_bpm)
            - beat_detected: True if a new beat was detected in this processing cycle
            - tempo_bpm: Current tempo estimate (None if not yet determined)
        """
        process_start_time = time.time()
        current_time = time.time() - self._processing_start_time
        timings = {}

        # Time-based history cleanup: remove beats older than 2 seconds
        # This ensures stale beats auto-expire during silent/ambient sections
        while len(self._beat_history) > 0 and (current_time - self._beat_history[0]) > 2.0:
            self._beat_history.popleft()

        # Get buffer snapshot
        with self._buffer_lock:
            if len(self._buffer) < self.buffer_samples_capture:
                # Buffer not full yet
                return False, None
            buffer_array = np.array(self._buffer, dtype=np.float32)

        # Resample to madmom sample rate (44.1kHz)
        t_before_resample = time.time()
        if self.capture_sample_rate != self.madmom_sample_rate:
            buffer_resampled = resample(buffer_array, self.buffer_samples_madmom)
            buffer_resampled = buffer_resampled.astype(np.float32)
        else:
            buffer_resampled = buffer_array
        timings['resample'] = time.time() - t_before_resample

        # Process with madmom
        try:
            t_before_beat_proc = time.time()
            activations = self._beat_proc(buffer_resampled)
            timings['beat_proc'] = time.time() - t_before_beat_proc

            t_before_track_proc = time.time()
            beats = self._track_proc(activations)
            timings['track_proc'] = time.time() - t_before_track_proc
        except Exception as e:
            print(f"[beat] Processing error: {e}")
            # Schedule next processing with minimum interval
            self._next_process_time = current_time + self.min_interval_seconds
            return False, self._estimated_bpm

        # Check activation level - skip beat detection during low-activation sections (silence/ambient)
        max_activation = np.max(activations) if len(activations) > 0 else 0.0
        if max_activation < self.activation_threshold:
            # No meaningful beat activity detected
            # Schedule next processing and return False (history will auto-expire over time)
            if self._estimated_bpm is not None:
                beat_interval = 60.0 / self._estimated_bpm
                next_interval = max(beat_interval / 2.0, self.min_interval_seconds)
            else:
                next_interval = self.min_interval_seconds
            self._next_process_time = current_time + next_interval
            return False, self._estimated_bpm

        # Convert beat times to absolute times (relative to buffer start)
        # beats are in seconds relative to start of buffer_resampled
        buffer_start_time = current_time - self.buffer_seconds
        beats_abs = beats + buffer_start_time

        # Debug logging: raw madmom output
        if self.debug:
            print(f"\n[beat] ═══ Processing @ t={current_time:.3f}s ═══")
            print(f"[beat] madmom returned {len(beats)} beats:")
            if len(beats) > 0:
                # Show first 10 beats
                beat_list = ", ".join([f"{b:.3f}s" for b in beats_abs[:10]])
                if len(beats) > 10:
                    beat_list += f", ... ({len(beats)-10} more)"
                print(f"[beat]   Raw: [{beat_list}]")
            else:
                print(f"[beat]   (no beats)")

        # SPATIAL FILTERING: Only look at beats in "new region" (last 0.5s of buffer)
        # This prevents re-detecting the same beat with jitter on subsequent cycles
        new_region_start = current_time - self._new_region_duration
        beats_in_new_region = beats_abs[beats_abs > new_region_start]

        # Debug logging: new region filtering
        if self.debug:
            print(f"[beat] New region filter (t > {new_region_start:.3f}s):")
            if len(beats_in_new_region) > 0:
                filtered_count = len(beats_abs) - len(beats_in_new_region)
                beat_list = ", ".join([f"{b:.3f}s" for b in beats_in_new_region[:10]])
                print(f"[beat]   Passed: {len(beats_in_new_region)} beats (filtered {filtered_count})")
                print(f"[beat]   [{beat_list}]")
            else:
                print(f"[beat]   All beats filtered (all in old region)")

        # Additional safety: filter against last reported beat (prevent duplicates)
        filter_threshold = self._last_reported_beat + self.min_beat_interval
        new_beats = beats_in_new_region[beats_in_new_region > filter_threshold]

        # Debug logging: duplicate filtering
        if self.debug:
            print(f"[beat] Duplicate filter (t > {filter_threshold:.3f}s, last_beat={self._last_reported_beat:.3f}s):")
            if len(new_beats) > 0:
                filtered_count = len(beats_in_new_region) - len(new_beats)
                beat_list = ", ".join([f"{b:.3f}s" for b in new_beats[:10]])
                print(f"[beat]   Passed: {len(new_beats)} beats (filtered {filtered_count})")
                print(f"[beat]   [{beat_list}]")
            else:
                print(f"[beat]   All beats filtered (too close to last beat)")

        # Tempo-based grid filtering: only accept beats on the expected tempo grid
        # This filters out spurious detections (false positives) when tempo is stable
        tempo_stable = False
        predicted_beat_time = None
        tolerance_window = None

        if len(new_beats) > 0 and len(self._beat_history) >= 4:
            # Check tempo stability: last 3 intervals should have low variance
            recent_intervals = np.diff(list(self._beat_history)[-4:])
            mean_interval = np.mean(recent_intervals)
            std_interval = np.std(recent_intervals)
            variance_ratio = std_interval / mean_interval if mean_interval > 0 else 1.0

            tempo_stable = variance_ratio < 0.10  # Less than 10% variance

            if tempo_stable:
                # Predict next beat time based on stable tempo
                predicted_beat_time = self._beat_history[-1] + mean_interval
                tolerance_window = mean_interval * 0.30  # ±30% tolerance

                # Filter beats: only accept those within tolerance of prediction AND maintaining tempo
                on_grid_beats = []
                for beat in new_beats:
                    # Check 1: Does beat align with predicted time?
                    deviation_from_prediction = abs(beat - predicted_beat_time)
                    within_prediction_tolerance = deviation_from_prediction <= tolerance_window

                    # Check 2: Does interval from last beat maintain tempo?
                    interval_from_last = beat - self._beat_history[-1]
                    interval_deviation_ratio = abs(interval_from_last - mean_interval) / mean_interval
                    maintains_tempo = interval_deviation_ratio < 0.30  # Same 30% tolerance

                    # Beat must pass BOTH checks
                    if within_prediction_tolerance and maintains_tempo:
                        on_grid_beats.append((beat, deviation_from_prediction))

                if len(on_grid_beats) > 0:
                    # Pick beat closest to prediction
                    on_grid_beats.sort(key=lambda x: x[1])  # Sort by deviation
                    selected_beat = on_grid_beats[0][0]
                    new_beats = np.array([selected_beat])
                else:
                    # All beats are off-grid - tempo likely changed or grid corrupted
                    # Reset to rebuilding phase by clearing history
                    if len(new_beats) > 0:
                        print(f"[beat-filter] All beats off-grid, resetting to rebuild tempo (clearing history)")
                        self._beat_history.clear()
                        # Accept the first new beat to start rebuilding
                        new_beats = np.array([new_beats[0]])
            else:
                # Tempo not stable - use all beats (continue building history)
                if self.debug:
                    print(f"[beat] Tempo grid filter:")
                    print(f"[beat]   Tempo stable: NO (variance={variance_ratio*100:.1f}%)")
                    print(f"[beat]   Accepting all beats (building tempo history)")

        # Determine if we detected a new beat
        beat_detected = len(new_beats) > 0

        # Lockup prevention: If we've rejected beats for too long, force accept the next available beat
        if not beat_detected:
            self._consecutive_rejections += 1
            if self._consecutive_rejections >= self._max_consecutive_rejections:
                # Force recovery: accept any beat from madmom's raw output
                if len(beats_abs) > 0:
                    print(f"[beat-filter] Force recovery after {self._consecutive_rejections} rejections, accepting beat from raw output")
                    # Take the most recent beat from madmom
                    forced_beat = beats_abs[-1]
                    new_beats = np.array([forced_beat])
                    beat_detected = True
                    # Clear history to rebuild tempo from scratch
                    self._beat_history.clear()
                self._consecutive_rejections = 0  # Reset counter
        else:
            # Beat accepted, reset rejection counter
            self._consecutive_rejections = 0

        if beat_detected:
            # Get the selected beat
            new_beat_time = new_beats[0]

            # Add to beat history
            self._beat_history.append(new_beat_time)

            # Log beat timestamp if logging is enabled
            if self._beat_logger:
                log_time = time.time() - self._processing_start_time
                processing_latency = time.time() - process_start_time
                interval = new_beat_time - self._last_reported_beat if self._last_reported_beat > -999.0 else None
                self._beat_logger.log_beat(new_beat_time, log_time, interval, self._estimated_bpm, len(self._beat_history), processing_latency, timings)

            # Calculate BPM from beat history (average intervals)
            if len(self._beat_history) >= 2:
                # Calculate intervals between consecutive beats in history
                intervals = np.diff(list(self._beat_history))
                avg_interval = np.mean(intervals)
                self._estimated_bpm = 60.0 / avg_interval

            # Debug logging: beat selection and timing
            if self.debug:
                time_since_last = new_beat_time - self._last_reported_beat
                print(f"[beat] ✓ BEAT DETECTED:")
                print(f"[beat]   Selected: {new_beat_time:.3f}s")
                print(f"[beat]   Time since last: {time_since_last:.3f}s ({time_since_last*1000:.0f}ms)")
                if self._estimated_bpm is not None:
                    expected_interval = 60.0 / self._estimated_bpm
                    deviation = (time_since_last - expected_interval) * 1000  # ms
                    print(f"[beat]   Expected interval: {expected_interval:.3f}s (@ {self._estimated_bpm:.1f} BPM)")
                    print(f"[beat]   Deviation: {deviation:+.0f}ms")
                else:
                    print(f"[beat]   BPM not yet estimated")

            # Update last reported beat to the FIRST new beat
            self._last_reported_beat = new_beat_time

            # Schedule next processing at half-beat interval (refractory period)
            if self._estimated_bpm is not None:
                beat_interval = 60.0 / self._estimated_bpm
                next_interval = max(beat_interval / 2.0, self.min_interval_seconds)
            else:
                next_interval = self.min_interval_seconds

            self._next_process_time = current_time + next_interval

            if self.debug:
                print(f"[beat]   Next processing @ t={self._next_process_time:.3f}s (+{next_interval:.3f}s)")
                print()  # Blank line for readability
        else:
            # No beat detected, schedule with minimum interval or tempo-based
            if self._estimated_bpm is not None:
                beat_interval = 60.0 / self._estimated_bpm
                next_interval = max(beat_interval / 2.0, self.min_interval_seconds)
            else:
                next_interval = self.min_interval_seconds

            self._next_process_time = current_time + next_interval

            if self.debug:
                print(f"[beat] ✗ No beat detected")
                print(f"[beat]   Next processing @ t={self._next_process_time:.3f}s (+{next_interval:.3f}s)")
                print()  # Blank line for readability

        return beat_detected, self._estimated_bpm

    def reset(self) -> None:
        """Reset the beat detector state (useful for testing)."""
        with self._buffer_lock:
            self._buffer.clear()
        self._last_reported_beat = -999.0
        self._estimated_bpm = None
        self._next_process_time = 0.0
        self._processing_start_time = time.time()
        self._beat_history.clear()
        self._consecutive_rejections = 0

        # Reset madmom tracker if it has reset method
        if hasattr(self._track_proc, 'reset'):
            self._track_proc.reset()


def main():
    """Test beat detection on synthetic audio."""
    print("Beat Detector Test")
    print("=" * 70)

    # Generate synthetic audio with clear beats
    duration = 10.0  # seconds
    bpm = 120
    sample_rate = 48000

    print(f"Generating {duration}s of synthetic audio @ {bpm} BPM...")

    samples = int(duration * sample_rate)
    audio = np.random.randn(samples).astype(np.float32) * 0.01  # Low noise floor

    # Add beats (impulses)
    beat_interval_samples = int(sample_rate * 60.0 / bpm)
    for i in range(0, samples, beat_interval_samples):
        if i < samples:
            audio[i:i+100] += 0.5 * np.exp(-np.arange(100) / 10)

    print(f"Expected beats: ~{int(duration * bpm / 60)} beats")
    print()

    # Create detector
    detector = BeatDetector()

    # Process in chunks (simulating real-time capture)
    chunk_size = 1024
    chunk_interval = chunk_size / sample_rate
    detected_beats = []

    print("Processing chunks...")
    for start in range(0, len(audio), chunk_size):
        chunk = audio[start:start + chunk_size]
        detector.add_chunk(chunk)

        # Check if processing is due
        if detector.should_process():
            beat, bpm_est = detector.process()
            if beat:
                current_time = start / sample_rate
                detected_beats.append(current_time)
                bpm_str = f"{bpm_est:.1f}" if bpm_est else "unknown"
                print(f"  Beat detected @ {current_time:.2f}s (tempo: {bpm_str} BPM)")

    print()
    print(f"Total beats detected: {len(detected_beats)}")
    print("=" * 70)


if __name__ == "__main__":
    main()
