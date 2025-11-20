"""
Real-time beat detection engine using madmom library.

Core component of CoBeART's audio processing pipeline. Processes live audio
streams to detect beats with tempo tracking and multi-stage filtering to
reduce false positives.

Key features:
- Online processing: Uses 2-second rolling buffer, suitable for real-time audio
- Tempo-aware: Tracks beat intervals and tempo stability (CV-based state machine)
- Filtered output: Spatial, duplicate, tempo-grid, and lockup prevention filters
- Thread-safe: Rolling buffer protected by lock for concurrent audio chunk addition
- Integration: Supports BeatLogger for offline analysis, PredictiveBeatLayer for latency reduction

Processing model:
- Call add_chunk() from audio thread to feed samples (non-blocking)
- Call should_process() to check if processing is due (tempo-driven intervals)
- Call process() to run detection (returns beat_detected flag and current tempo)
- Detector self-schedules next processing time based on tempo state

Performance characteristics:
- Buffer conversion: O(n) where n=buffer_samples (deque→array copy)
- Resampling: O(n*log(n)) FFT-based when sample rates differ, O(1) when same
- madmom RNN: O(n) neural network inference (dominant cost, ~50-100ms typical)
- madmom DBN: O(n) dynamic programming for beat tracking (~20-50ms typical)
- Filtering: O(k) where k=candidate_beats (typically 1-5, vectorized NumPy ops)
- Total latency: Primarily determined by buffer size (2s) + madmom processing time

Dependencies:
- madmom: Neural beat tracking (optional, lazy import)
- scipy: Resampling (always required)
- numpy: Array operations (always required)
"""
import time
import numpy as np
import threading
from collections import deque
from typing import Tuple, Optional
from scipy.signal import resample


# Sentinel value indicating no beat has been detected yet
# Uses numeric constant instead of None for performance: numeric comparison (>) is faster
# than identity check (is None) in hot paths like duplicate filtering
_NO_BEAT_SENTINEL = -999.0


class BeatDetector:
    """
    Real-time beat detection using madmom library with sophisticated filtering pipeline.

    Architecture:
    - Rolling 2-second audio buffer with resampling (48kHz → 44.1kHz)
    - madmom RNNBeatProcessor + DBNBeatTrackingProcessor (online mode)
    - Multi-stage filtering: spatial, duplicate, tempo-grid, lockup prevention
    - Count-based beat history (last 8 beats) for tempo estimation
    - Dynamic processing intervals: tempo-driven when stable, frequent polling when unstable
    - Tempo stability detection: tracks variance in recent beat intervals

    The detector returns beat timestamps as absolute Unix epoch times and maintains
    internal state for tempo tracking. Uses sentinel value (-999.0) instead of None
    for uninitialized state to avoid type checking overhead in hot paths.

    Filtering Pipeline:
    1. Spatial filtering: Only process beats in "new region" (prevents re-detection)
    2. Duplicate filtering: Enforce minimum beat separation (default 200ms)
    3. Tempo state update: Analyze last 3 intervals for stability (CV < 10%)
    4. Grid filtering: When stable, enforce alignment with predicted tempo grid
    5. Lockup prevention: Force recovery after 10 consecutive rejections
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
            min_interval_seconds: Minimum time between processing calls in seconds (default 0,
                which gets replaced by tempo-driven intervals when stable, or frequent polling when unstable)
            min_beat_interval: Minimum time between beats to prevent duplicates (default 0.2s = 200ms)
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
        self._last_reported_beat = _NO_BEAT_SENTINEL  # Time of last reported beat
        self._estimated_bpm = None  # Current tempo estimate
        self._beat_interval = None  # Cached beat interval (60.0 / BPM) for efficiency
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
        from cobeart.audiocapture.beat.logger import BeatLogger
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

        Uses lock to prevent race conditions with add_chunk() calls from audio thread.

        Returns:
            Buffer array as numpy array, or None if buffer not yet full

        Performance: O(n) where n is buffer size due to deque→array conversion
        """
        with self._buffer_lock:
            if len(self._buffer) < self.buffer_samples_capture:
                return None
            return np.array(self._buffer)

    def _resample_buffer(self, buffer_array: np.ndarray, timings: dict) -> np.ndarray:
        """
        Resample buffer to madmom sample rate if needed.

        Uses scipy.signal.resample for high-quality resampling. If sample rates match,
        returns original buffer without copying.

        Args:
            buffer_array: Audio buffer at capture sample rate
            timings: Dictionary to record timing metrics (adds 'resample' key)

        Returns:
            Resampled buffer at madmom sample rate (always float32)

        Performance: O(n*log(n)) for FFT-based resampling when rates differ, O(1) when same
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

        Prevents processing silent or low-energy audio sections. When activation is too low,
        schedules next processing based on current tempo state (beat_interval if stable,
        min_interval if unstable). Beat history auto-expires via maxlen, so no manual clearing.

        Args:
            activations: Beat activation function from madmom (1D array)
            current_time: Current absolute timestamp

        Returns:
            True to continue processing, False to skip (next processing already scheduled)

        Performance: O(n) for np.max() scan over activation array
        """
        max_activation = np.max(activations) if len(activations) > 0 else 0.0
        if max_activation < self.activation_threshold:
            # No meaningful beat activity detected
            # Schedule next processing and return False (history will auto-expire over time)
            if self._beat_interval is not None:
                next_interval = max(self._beat_interval, self.min_interval_seconds)
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

        Prevents re-detecting beats from previous processing cycles by only considering
        beats within a time window before current_time:
        - Stable tempo: Window = beat_interval (matches processing interval)
        - Unstable tempo: Window = 1.0s (accommodates slow tempos ≥60 BPM)

        Args:
            beats_abs: Beat timestamps in absolute time
            current_time: Current absolute timestamp

        Returns:
            Filtered beats in new region (beats with timestamp > new_region_start)

        Performance: O(n) for numpy boolean indexing operation
        """
        # Calculate new region duration based on tempo state
        if self._tempo_state == "stable" and self._beat_interval is not None:
            new_region_duration = self._beat_interval
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

        Prevents multiple detections of the same physical beat by enforcing minimum
        time separation (min_beat_interval, default 200ms). Only keeps beats occurring
        after last_reported_beat + min_beat_interval.

        Args:
            beats_in_new_region: Beats in new region

        Returns:
            Beats with duplicates removed (timestamp > threshold)

        Performance: O(n) for numpy boolean indexing operation
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

        Analyzes last 3 intervals (from last 4 beats) to determine tempo stability.
        Transitions between "stable" and "unstable" states based on variance ratio.
        When stable, returns tempo grid parameters for filtering.

        Args:
            new_beats: New beats to consider (must have length > 0 to trigger analysis)

        Returns:
            Tuple of (mean_interval, predicted_beat_time, tolerance_window) if stable with ≥4 beats,
            None otherwise (including when unstable or insufficient beat history)

        Performance: O(1) for fixed-size history slice (last 4 beats)

        Note: IQR outlier filtering was considered but provides minimal benefit with only 3 intervals.
        """
        if len(new_beats) > 0 and len(self._beat_history) >= 4:
            # Check tempo stability: last 3 intervals should have low variance.
            # NOTE: Using only last 4 beats (3 intervals) was empirically more accurate
            # than using full beat_history. Captures recent tempo changes while avoiding
            # over-smoothing from older beats at different tempos.
            recent_intervals = np.diff(list(self._beat_history)[-4:])
            mean_interval = np.mean(recent_intervals)
            std_interval = np.std(recent_intervals)
            # variance_ratio = coefficient of variation (CV): normalized measure of interval consistency
            # NOT a BPM calculation - this is tempo stability metric used for state transitions
            # CV < 10% indicates stable tempo, CV >= 10% indicates unstable/changing tempo
            variance_ratio = std_interval / mean_interval if mean_interval > 0 else 1.0

            # Update tempo state based on variance ratio
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

        Only accepts beats that align with predicted tempo grid. Uses vectorized checks:
        1. Beat must be within tolerance_window of predicted_beat_time
        2. Beat's interval from last beat must maintain tempo (within variance threshold)

        Beats must satisfy BOTH conditions (bitwise & on boolean masks). If no beats pass,
        clears history and accepts first beat to restart tempo tracking.

        Args:
            new_beats: Candidate beats (may be empty)
            mean_interval: Mean interval from beat history
            predicted_beat_time: Predicted time of next beat (last_beat + mean_interval)
            tolerance_window: Tolerance window for prediction (mean_interval * variance_threshold)

        Returns:
            Single-element array with beat closest to prediction, or first beat if all off-grid,
            or empty array if no beats provided

        Performance: O(n) for vectorized operations on all candidate beats
        """
        if len(new_beats) == 0:
            return new_beats

        # Vectorized check 1: alignment with predicted time
        deviations = np.abs(new_beats - predicted_beat_time)
        within_tolerance = deviations <= tolerance_window

        # Vectorized check 2: interval from last beat maintains tempo
        intervals = new_beats - self._beat_history[-1]
        interval_deviations = np.abs(intervals - mean_interval) / mean_interval
        maintains_tempo = interval_deviations < self._tempo_variance_threshold

        # Combine checks: beat must pass BOTH conditions
        # Uses bitwise & for element-wise AND on numpy boolean arrays
        # (logical 'and' operator would fail on arrays - only works for scalars)
        valid_mask = within_tolerance & maintains_tempo
        valid_beats = new_beats[valid_mask]
        valid_deviations = deviations[valid_mask]

        if len(valid_beats) > 0:
            # Pick beat with minimum deviation from prediction
            min_idx = np.argmin(valid_deviations)
            return np.array([valid_beats[min_idx]])
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

        Tracks consecutive rejections and forces recovery after max threshold
        (default 10 rejections ≈ 2-4 seconds). Takes most recent beat from madmom's
        raw output and clears history to rebuild tempo from scratch. Resets rejection
        counter on any accepted beat.

        Args:
            beat_detected: Whether a beat was detected in filtering pipeline
            beats_abs: All beats from madmom before filtering (for forced recovery)
            new_beats: Beats after filtering

        Returns:
            Tuple of (beat_detected, new_beats) with forced recovery applied if triggered

        Performance: O(1) counter tracking
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
        Handle detected beat: add to history, log, calculate BPM, update state.

        Adds beat to history (auto-expires oldest via maxlen=8), logs to file if enabled,
        calculates BPM from average of all intervals in history, caches beat_interval
        for performance, and updates last_reported_beat.

        Args:
            new_beat_time: Timestamp of detected beat (absolute Unix time)
            process_start_time: When processing started (for latency calculation)
            timings: Processing timing metrics (dict with 'resample', 'beat_proc', 'track_proc' keys)

        Performance: O(n) where n is history size (max 8) for BPM calculation
        """
        # Add to beat history
        self._beat_history.append(new_beat_time)

        # Log beat timestamp if logging is enabled
        if self._beat_logger:
            processing_latency = time.time() - process_start_time
            log_time = process_start_time + processing_latency  # Same value, no extra syscall
            interval = new_beat_time - self._last_reported_beat if self._last_reported_beat > _NO_BEAT_SENTINEL else None
            self._beat_logger.log_beat(new_beat_time, log_time, interval, self._estimated_bpm, len(self._beat_history), processing_latency, timings)

        # Calculate BPM from beat history (average intervals)
        if len(self._beat_history) >= 2:
            # Calculate intervals between consecutive beats in history
            intervals = np.diff(np.array(self._beat_history))
            avg_interval = np.mean(intervals)
            self._estimated_bpm = 60.0 / avg_interval
            # Cache the interval for performance: avoids repeated division in hot paths
            # (processing interval scheduling, grid filtering, spatial filtering)
            self._beat_interval = avg_interval

        # Debug logging: beat selection and timing
        if self.debug:
            time_since_last = new_beat_time - self._last_reported_beat
            print(f"[beat] ✓ BEAT DETECTED:")
            print(f"[beat]   Selected: {new_beat_time:.3f}s")
            print(f"[beat]   Time since last: {time_since_last:.3f}s ({time_since_last*1000:.0f}ms)")
            if self._beat_interval is not None:
                deviation = (time_since_last - self._beat_interval) * 1000  # ms
                print(f"[beat]   Expected interval: {self._beat_interval:.3f}s (@ {self._estimated_bpm:.1f} BPM)")
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
        if self._tempo_state == "stable" and self._beat_interval is not None:
            # Stable tempo: use beat interval (refractory period)
            next_interval = max(self._beat_interval, self.min_interval_seconds)
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

    def get_prediction_state(self) -> Tuple[Optional[float], Optional[float], Optional[float]]:
        """
        Get state information for predictive beat generation.

        Returns prediction data only when tempo is stable with sufficient beat history.
        This enables low-latency beat prediction by extrapolating from recent beats.

        Returns:
            Tuple of (last_beat_timestamp, beat_interval, tempo_bpm) when all conditions met:
            - At least 4 beats in history
            - Tempo state is "stable"
            - beat_interval is cached (not None)

            Returns (None, None, None) if any condition fails (unstable or insufficient data)

        Thread-safety note: Not internally locked. Caller should handle synchronization
        if accessed from multiple threads.
        """
        # Need at least 4 beats and stable tempo for reliable predictions
        if len(self._beat_history) >= 4 and self._tempo_state == "stable" and self._beat_interval is not None:
            last_beat_timestamp = self._beat_history[-1]
            return (last_beat_timestamp, self._beat_interval, self._estimated_bpm)
        return None, None, None

    def reset(self) -> None:
        """Reset the beat detector state (useful for testing)."""
        with self._buffer_lock:
            self._buffer.clear()
        self._last_reported_beat = _NO_BEAT_SENTINEL
        self._estimated_bpm = None
        self._beat_interval = None
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
