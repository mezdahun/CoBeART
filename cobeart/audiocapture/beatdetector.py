import time
import numpy as np
import threading
from collections import deque
from typing import Tuple, Optional
from scipy.signal import resample


class BeatDetector:
    """
    Real-time beat detection using madmom library.

    Uses a count-based beat history (8 beats) with dynamic tempo-driven processing
    intervals and refractory period optimization for efficient CPU usage.

    See BEAT_DETECTION.md for architectural details and rationale.
    """

    def __init__(
        self,
        buffer_seconds: float = 2,
        capture_sample_rate: int = 48000,
        madmom_sample_rate: int = 44100,
        min_interval_seconds: float = 0,
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
        self._track_proc = DBNBeatTrackingProcessor(fps=100, online=True, transition_lambda=1000)
        print("[beat] Processors initialized")

        # State tracking (all timestamps are absolute Unix epoch time)
        self._last_reported_beat = -999.0  # Time of last reported beat
        self._estimated_bpm = None  # Current tempo estimate
        self._next_process_time = time.time()  # When to next process buffer (absolute)

        # Beat history for BPM calculation (count-based expiry: last 8 beats)
        self._beat_history = deque(maxlen=8)  # Last 8 beats (auto-expires via maxlen)

        # Lockup prevention: track consecutive rejections
        self._consecutive_rejections = 0
        self._max_consecutive_rejections = 10  # Force accept after 10 rejections (~2-4 seconds)

        # Tempo stability state tracking
        self._tempo_state = "unstable"  # "unstable" or "stable"
        self._tempo_variance_threshold = 0.10  # 10% variance for stability

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
        return time.time() >= self._next_process_time

    def _get_buffer_snapshot(self) -> Optional[np.ndarray]:
        """
        Get thread-safe snapshot of audio buffer.

        Returns:
            Buffer array, or None if buffer not yet full
        """
        with self._buffer_lock:
            if len(self._buffer) < self.buffer_samples_capture:
                return None
            return np.array(self._buffer, dtype=np.float32)

    def _resample_buffer(self, buffer_array: np.ndarray, timings: dict) -> np.ndarray:
        """
        Resample buffer to madmom sample rate if needed.

        Args:
            buffer_array: Audio buffer at capture sample rate
            timings: Dictionary to record timing metrics

        Returns:
            Resampled buffer at madmom sample rate
        """
        t_before_resample = time.time()
        if self.capture_sample_rate != self.madmom_sample_rate:
            buffer_resampled = resample(buffer_array, self.buffer_samples_madmom)
            buffer_resampled = buffer_resampled.astype(np.float32)
        else:
            buffer_resampled = buffer_array
        timings['resample'] = time.time() - t_before_resample
        return buffer_resampled

    def _run_madmom_detection(
        self,
        buffer_resampled: np.ndarray,
        current_time: float,
        timings: dict
    ) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], bool]:
        """
        Run madmom RNN and DBN beat detection processors.

        Args:
            buffer_resampled: Audio buffer at madmom sample rate
            current_time: Current absolute timestamp
            timings: Dictionary to record timing metrics

        Returns:
            Tuple of (beats, activations, success)
            - beats: Beat timestamps from madmom (relative to buffer start)
            - activations: Beat activation function
            - success: True if processing succeeded, False if error occurred
        """
        try:
            t_before_beat_proc = time.time()
            activations = self._beat_proc(buffer_resampled)
            timings['beat_proc'] = time.time() - t_before_beat_proc

            t_before_track_proc = time.time()
            beats = self._track_proc(activations)
            timings['track_proc'] = time.time() - t_before_track_proc

            return beats, activations, True
        except Exception as e:
            print(f"[beat] Processing error: {e}")
            # Schedule next processing with minimum interval
            self._next_process_time = current_time + self.min_interval_seconds
            return None, None, False

    def _check_activation_threshold(self, activations: np.ndarray, current_time: float) -> bool:
        """
        Check if audio has meaningful beat activity above threshold.

        Args:
            activations: Beat activation function from madmom
            current_time: Current absolute timestamp

        Returns:
            True to continue processing, False to skip (schedules next processing)
        """
        max_activation = np.max(activations) if len(activations) > 0 else 0.0
        if max_activation < self.activation_threshold:
            # No meaningful beat activity detected
            # Schedule next processing and return False (history will auto-expire over time)
            if self._estimated_bpm is not None:
                beat_interval = 60.0 / self._estimated_bpm
                next_interval = max(beat_interval, self.min_interval_seconds)
            else:
                next_interval = self.min_interval_seconds
            self._next_process_time = current_time + next_interval
            return False
        return True

    def _convert_to_absolute_timestamps(self, beats: np.ndarray, current_time: float) -> np.ndarray:
        """
        Convert madmom beat times (relative to buffer start) to absolute timestamps.

        Args:
            beats: Beat times in seconds relative to buffer start
            current_time: Current absolute timestamp

        Returns:
            Beat timestamps in absolute time
        """
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

        return beats_abs

    def _filter_spatial(self, beats_abs: np.ndarray, current_time: float) -> np.ndarray:
        """
        Filter beats to only those in "new region" based on tempo state.

        - Stable tempo: Window = beat_interval (matches processing interval)
        - Unstable tempo: Window = 1.0s (accommodates ≥60 BPM)

        This prevents re-detecting beats from previous cycles.

        Args:
            beats_abs: Beat timestamps in absolute time
            current_time: Current absolute timestamp

        Returns:
            Filtered beats in new region
        """
        # Calculate new region duration based on tempo state
        if self._tempo_state == "stable" and self._estimated_bpm is not None:
            beat_interval = 60.0 / self._estimated_bpm
            new_region_duration = beat_interval
        else:
            new_region_duration = 1.0  # Accommodate slow tempos ≥60 BPM

        new_region_start = current_time - new_region_duration
        beats_in_new_region = beats_abs[beats_abs > new_region_start]

        # Debug logging: new region filtering
        if self.debug:
            print(f"[beat] New region filter (window={new_region_duration:.3f}s, t > {new_region_start:.3f}s):")
            if len(beats_in_new_region) > 0:
                filtered_count = len(beats_abs) - len(beats_in_new_region)
                beat_list = ", ".join([f"{b:.3f}s" for b in beats_in_new_region[:10]])
                print(f"[beat]   Passed: {len(beats_in_new_region)} beats (filtered {filtered_count})")
                print(f"[beat]   [{beat_list}]")
            else:
                print(f"[beat]   All beats filtered (all in old region)")

        return beats_in_new_region

    def _filter_duplicates(self, beats_in_new_region: np.ndarray) -> np.ndarray:
        """
        Filter out beats too close to last reported beat.

        Args:
            beats_in_new_region: Beats in new region

        Returns:
            Beats with duplicates removed
        """
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

        return new_beats

    def _update_tempo_state(self, new_beats: np.ndarray) -> Optional[Tuple[float, float, float]]:
        """
        Update tempo stability state based on beat history variance.

        Args:
            new_beats: New beats to consider

        Returns:
            Tuple of (mean_interval, predicted_beat_time, tolerance_window) if stable with ≥4 beats,
            None otherwise
        """

        # Idea to implement IQR outlier filtering, but with only 3 intervals to verify, it doesn't do much.
        if len(new_beats) > 0 and len(self._beat_history) >= 4:
            # Check tempo stability: last 3 intervals should have low variance.
            # Tried: the full beat_history, and it was less accurate.
            recent_intervals = np.diff(list(self._beat_history)[-4:])
            mean_interval = np.mean(recent_intervals)
            std_interval = np.std(recent_intervals)
            variance_ratio = std_interval / mean_interval if mean_interval > 0 else 1.0

            # Update tempo state
            old_state = self._tempo_state
            if variance_ratio < self._tempo_variance_threshold:
                self._tempo_state = "stable"
            else:
                self._tempo_state = "unstable"

            # Log state transitions
            if old_state != self._tempo_state and self.debug:
                print(f"[beat] Tempo state changed: {old_state} → {self._tempo_state} (variance={variance_ratio*100:.1f}%)")

            if self._tempo_state == "stable":
                # Return tempo grid parameters
                predicted_beat_time = self._beat_history[-1] + mean_interval
                tolerance_window = mean_interval * self._tempo_variance_threshold
                return mean_interval, predicted_beat_time, tolerance_window
        else:
            # Not enough beats to determine stability
            self._tempo_state = "unstable"

        return None

    def _apply_grid_filter(
        self,
        new_beats: np.ndarray,
        mean_interval: float,
        predicted_beat_time: float,
        tolerance_window: float
    ) -> np.ndarray:
        """
        Apply tempo-based grid filtering when tempo is stable.

        Only accepts beats that align with predicted tempo grid.

        Args:
            new_beats: Candidate beats
            mean_interval: Mean interval from beat history
            predicted_beat_time: Predicted time of next beat
            tolerance_window: Tolerance window for prediction (±30%)

        Returns:
            Filtered beats (single beat closest to prediction, or first beat if all off-grid)
        """
        # Filter beats: only accept those within tolerance of prediction AND maintaining tempo
        on_grid_beats = []
        for beat in new_beats:
            # Check 1: Does beat align with predicted time?
            deviation_from_prediction = abs(beat - predicted_beat_time)
            within_prediction_tolerance = deviation_from_prediction <= tolerance_window

            # Check 2: Does interval from last beat maintain tempo?
            interval_from_last = beat - self._beat_history[-1]
            interval_deviation_ratio = abs(interval_from_last - mean_interval) / mean_interval
            maintains_tempo = interval_deviation_ratio < self._tempo_variance_threshold

            # Beat must pass BOTH checks
            if within_prediction_tolerance and maintains_tempo:
                on_grid_beats.append((beat, deviation_from_prediction))

        if len(on_grid_beats) > 0:
            # Pick beat closest to prediction
            on_grid_beats.sort(key=lambda x: x[1])  # Sort by deviation
            selected_beat = on_grid_beats[0][0]
            return np.array([selected_beat])
        else:
            # All beats are off-grid - tempo likely changed or grid corrupted
            # Reset to unstable state by clearing history
            if len(new_beats) > 0:
                print(f"[beat-filter] All beats off-grid, resetting to unstable state (clearing history)")
                self._beat_history.clear()
                self._tempo_state = "unstable"
                # Accept the first new beat to start rebuilding
                return np.array([new_beats[0]])
            return new_beats

    def _apply_lockup_prevention(
        self,
        beat_detected: bool,
        beats_abs: np.ndarray,
        new_beats: np.ndarray
    ) -> Tuple[bool, np.ndarray]:
        """
        Force-accept beat if stuck rejecting for too long.

        Args:
            beat_detected: Whether a beat was detected
            beats_abs: All beats from madmom (before filtering)
            new_beats: Beats after filtering

        Returns:
            Tuple of (beat_detected, new_beats) with forced recovery applied if needed
        """
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

        return beat_detected, new_beats

    def _handle_beat_detected(
        self,
        new_beat_time: float,
        process_start_time: float,
        timings: dict
    ) -> None:
        """
        Handle detected beat: add to history, log, calculate BPM.

        Args:
            new_beat_time: Timestamp of detected beat
            process_start_time: When processing started (for latency calculation)
            timings: Processing timing metrics
        """
        # Add to beat history
        self._beat_history.append(new_beat_time)

        # Log beat timestamp if logging is enabled
        if self._beat_logger:
            log_time = time.time()  # Absolute timestamp
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

        # Update last reported beat
        self._last_reported_beat = new_beat_time

    def _schedule_next_processing(self, current_time: float, beat_detected: bool) -> None:
        """
        Schedule next processing based on tempo state.

        Args:
            current_time: Current absolute timestamp
            beat_detected: Whether a beat was detected
        """
        if self._tempo_state == "stable" and self._estimated_bpm is not None:
            # Stable tempo: use half-beat interval (refractory period)
            beat_interval = 60.0 / self._estimated_bpm
            next_interval = max(beat_interval, self.min_interval_seconds)
        else:
            # Unstable tempo: poll frequently to catch next beat quickly
            next_interval = self.min_interval_seconds

        self._next_process_time = current_time + next_interval

        if self.debug:
            if beat_detected:
                print(f"[beat]   Tempo state: {self._tempo_state}")
                print(f"[beat]   Next processing @ t={self._next_process_time:.3f}s (+{next_interval:.3f}s)")
                print()  # Blank line for readability
            else:
                print(f"[beat] ✗ No beat detected")
                print(f"[beat]   Next processing @ t={self._next_process_time:.3f}s (+{next_interval:.3f}s)")
                print()  # Blank line for readability

    def process(self) -> Tuple[bool, Optional[float]]:
        """
        Process buffer for beat detection.

        Orchestrates the complete beat detection pipeline by calling focused helper methods.

        Returns:
            Tuple of (beat_detected, tempo_bpm)
            - beat_detected: True if a new beat was detected in this processing cycle
            - tempo_bpm: Current tempo estimate (None if not yet determined)
        """
        process_start_time = time.time()
        timings = {}

        # 1. Get buffer snapshot
        buffer_array = self._get_buffer_snapshot()
        if buffer_array is None:
            return False, None

        # 2. Resample to madmom rate
        buffer_resampled = self._resample_buffer(buffer_array, timings)

        # 3. Run madmom detection
        beats, activations, success = self._run_madmom_detection(buffer_resampled, process_start_time, timings)
        if not success:
            return False, self._estimated_bpm

        # 4. Check activation threshold
        if not self._check_activation_threshold(activations, process_start_time):
            return False, self._estimated_bpm

        # 5. Convert to absolute timestamps
        beats_abs = self._convert_to_absolute_timestamps(beats, process_start_time)

        # 6. Apply spatial filtering
        beats_in_new_region = self._filter_spatial(beats_abs, process_start_time)

        # 7. Filter duplicates
        new_beats = self._filter_duplicates(beats_in_new_region)

        # 8. Update tempo state
        tempo_data = self._update_tempo_state(new_beats)

        # 9. Apply grid filter if tempo is stable
        if tempo_data is not None:
            new_beats = self._apply_grid_filter(new_beats, *tempo_data)
        elif self.debug and self._tempo_state == "unstable":
            print(f"[beat] Tempo state: {self._tempo_state} - accepting all beats")

        # 10. Apply lockup prevention
        beat_detected, new_beats = self._apply_lockup_prevention(len(new_beats) > 0, beats_abs, new_beats)

        # 11. Handle detected beat
        if beat_detected:
            self._handle_beat_detected(new_beats[0], process_start_time, timings)

        # 12. Schedule next processing
        self._schedule_next_processing(process_start_time, beat_detected)

        return beat_detected, self._estimated_bpm

    def get_prediction_state(self) -> Optional[Tuple[float, float, float]]:
        """
        Get state information for predictive beat generation.

        Returns prediction data only when tempo is stable with sufficient beat history.
        This enables low-latency beat prediction by extrapolating from recent beats.

        Returns:
            Tuple of (last_beat_timestamp, beat_interval, tempo_bpm) if stable with ≥4 beats,
            None otherwise

        Thread-safety note: Caller should handle locking if accessed from multiple threads.
        """
        # Need at least 4 beats and stable tempo for reliable predictions
        if len(self._beat_history) >= 4 and self._tempo_state == "stable" and self._estimated_bpm is not None:
            last_beat_timestamp = self._beat_history[-1]
            beat_interval = 60.0 / self._estimated_bpm
            return (last_beat_timestamp, beat_interval, self._estimated_bpm)
        return None, None, None

    def reset(self) -> None:
        """Reset the beat detector state (useful for testing)."""
        with self._buffer_lock:
            self._buffer.clear()
        self._last_reported_beat = -999.0
        self._estimated_bpm = None
        self._next_process_time = time.time()  # Absolute timestamp
        self._beat_history.clear()
        self._consecutive_rejections = 0
        self._tempo_state = "unstable"

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
