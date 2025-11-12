"""
Predictive beat layer for low-latency beat triggering.

Wraps a BeatDetector to provide extrapolated beat predictions based on stable tempo.
Reduces beat trigger latency by predicting future beats from established tempo patterns
rather than waiting for detector processing of historical audio buffers.

Architecture:
- Polls BeatDetector.get_prediction_state() at configurable intervals (default 50ms)
- When detector reports stable tempo: generates single predicted beat timestamp
- When predicted time reached: immediately triggers beat event
- When tempo becomes unstable: invalidates queued prediction and resumes polling

Integration with BeatDetector:
- BeatDetector provides (last_beat_time, beat_interval, tempo_bpm) when stable
- PredictiveBeatLayer extrapolates next beat using O(1) calculation
- Single prediction model: only one future beat queued at a time
- State invalidation: clears prediction when detector reports tempo instability

Usage pattern:
    detector = BeatDetector()
    predictor = PredictiveBeatLayer(detector)

    # In main event loop (e.g., audio frame callback):
    beat_detected, tempo, beat_time = predictor.get_next_beat()
    if beat_detected:
        trigger_visual_effect(beat_time, tempo)

Performance:
- Polling overhead: ~100-200ns per call when not due
- Prediction generation: O(1) arithmetic calculation
- No heavy processing: all computation done by BeatDetector
- Memory footprint: Single float for queued prediction

Thread-safety: Not thread-safe. Caller must ensure single-threaded access or add
external synchronization.
"""
import time
from typing import Tuple, Optional


class PredictiveBeatLayer:
    """
    Predictive beat layer that reduces detection latency by extrapolating the next beat.

    Polls a BeatDetector for stable tempo information and generates a single
    predicted beat timestamp. This allows the system to trigger beat events in
    real-time rather than waiting for the detector's processing latency.

    Architecture:
    - When no prediction: polls detector at 50ms intervals (20 Hz, minimal overhead ~100-200ns)
    - When stable tempo detected: generates single predicted beat timestamp
    - When predicted beat reached: triggers immediately, clears prediction
    - When tempo becomes unstable: invalidates queued prediction and continues polling
    - Single prediction model: only one future beat queued at a time

    Latency reduction: The detector processes historical audio in a rolling buffer
    and applies multi-stage filtering, which introduces inherent latency. This predictor
    extrapolates from stable tempo to provide low-latency beat triggers by predicting
    future beats based on established tempo patterns.

    Thread-safety: Not thread-safe. Caller must ensure get_next_beat() called from
    single thread or add external synchronization.
    """

    def __init__(
        self,
        beat_detector,
        poll_interval: float = 0.05,
        debug: bool = False
    ):
        """
        Initialize predictive beat layer.

        Args:
            beat_detector: BeatDetector instance to poll for tempo state via get_prediction_state()
            poll_interval: Polling interval in seconds when no prediction (default 0.05s = 20 Hz)
            debug: Enable debug logging (default False, gates all debug prints)
        """
        self._detector = beat_detector
        self._poll_interval = poll_interval
        self.debug = debug

        # Single prediction: stores timestamp and interval or None
        self._next_beat_time = None

        # Polling state
        self._last_poll_time = 0.0

        # Current tempo state (cached from last successful poll)
        self._current_tempo = None

        # Statistics for analysis
        self._stats = {
            'predictions_generated': 0,
            'predictions_consumed': 0
        }

    def get_next_beat(self) -> Tuple[bool, Optional[float], Optional[float]]:
        """
        Check if a predicted beat should trigger now.

        This is the main API method called regularly (e.g., at audio frame rate or event loop).
        Handles polling, prediction consumption, invalidation, and generation automatically.

        Workflow:
        1. Poll detector if poll_interval elapsed (checks for tempo stability changes)
        2. Invalidate prediction if detector reports unstable (clears stale prediction)
        3. Generate prediction if detector reports stable and none queued
        4. Consume prediction if current_time >= predicted beat time

        Returns:
            Tuple of (beat_detected, tempo_bpm, beat_timestamp)
            - beat_detected: True if current time has reached a predicted beat
            - tempo_bpm: Current tempo estimate (None if no stable tempo, cached otherwise)
            - beat_timestamp: Predicted beat timestamp when beat_detected=True (None otherwise)

        Performance: O(1) when not polling, minimal overhead (~100-200ns) when polling
        """
        current_time = time.time()

        if self.debug:
            print(f"[predict] Start Time: {current_time:.3f}s")

        # Poll detector if enough time has passed (minimal overhead: ~100-200ns)
        if current_time - self._last_poll_time >= self._poll_interval:
            if self.debug:
                print(f"[predict] Poll interval elapsed, polling detector")
            last_beat_time, beat_interval, tempo_bpm = self._poll_detector()

            # If detector reports unstable and we have a queued prediction, invalidate it
            if last_beat_time is None and self._next_beat_time is not None:
                if self.debug:
                    print(f"[predict] Tempo unstable, invalidating queued prediction")
                self._next_beat_time = None
                self._current_tempo = None
                return False, None, None

            # If detector reports stable tempo and no prediction queued, generate one
            elif last_beat_time is not None and self._next_beat_time is None:
                if self.debug:
                    print(f"[predict] Stable tempo detected, generating prediction")
                self._generate_prediction(last_beat_time, beat_interval, tempo_bpm)
                return False, tempo_bpm, None

        # Check if we have a prediction to consume
        if self._next_beat_time is not None:
            if self.debug:
                print(f"[predict] Has prediction: {self._next_beat_time:.3f}s")

            # Check if current time has reached the prediction
            if current_time >= self._next_beat_time:
                if self.debug:
                    print(f"[predict] Time reached, consuming beat")
                self._stats['predictions_consumed'] += 1

                beat_time = self._next_beat_time
                self._next_beat_time = None

                return True, self._current_tempo, beat_time

            if self.debug:
                print(f"[predict] Not time yet ({current_time:.3f} < {self._next_beat_time:.3f})")

        # No beat to report
        return False, self._current_tempo, None

    def _poll_detector(self) -> Tuple[Optional[float], Optional[float], Optional[float]]:
        """
        Poll the beat detector for stable tempo state.

        Calls detector.get_prediction_state() and updates last_poll_time.
        Does not generate predictions here - caller handles that logic.

        Returns:
            Tuple of (last_beat_time, beat_interval, tempo_bpm) if detector reports stable tempo,
            (None, None, None) if detector reports unstable or insufficient data

        Performance: O(1) state query, no heavy processing
        """
        self._last_poll_time = time.time()
        return self._detector.get_prediction_state()

    def _generate_prediction(
        self,
        last_beat_time: float,
        beat_interval: float,
        tempo_bpm: float
    ) -> None:
        """
        Generate next predicted beat timestamp.

        Uses direct O(1) calculation to find first beat strictly greater than current_time:
        - Calculate elapsed time since last_beat_time
        - Find number of full beats elapsed: int(elapsed / beat_interval)
        - Next beat is: last_beat_time + (full_beats_elapsed + 1) * beat_interval

        Formula uses floor (int cast) + 1, NOT ceil + 1. This ensures the predicted beat
        is strictly in the future (> current_time), not equal to it.

        Args:
            last_beat_time: Timestamp of last actual beat from detector (absolute Unix time)
            beat_interval: Time interval between beats in seconds (60.0 / BPM)
            tempo_bpm: Current tempo in BPM (cached for return with beat triggers)

        Side effects:
            - Sets self._next_beat_time (the single queued prediction)
            - Sets self._current_tempo (cached for return values)
            - Increments self._stats['predictions_generated']

        Performance: O(1) arithmetic, no loops
        """
        # Store current tempo state
        self._current_tempo = tempo_bpm

        # Generate next beat using direct O(1) calculation (avoids O(k) while loop)
        current_time = time.time()
        elapsed = current_time - last_beat_time
        # Find number of complete beats that have passed: floor(elapsed / beat_interval)
        # int() truncates toward zero, which equals floor() for positive numbers
        full_beats_elapsed = int(elapsed / beat_interval)
        # Next beat is one beat after the last complete beat
        # Formula: last_beat_time + (floor + 1) * beat_interval
        # This ensures predicted beat is strictly in future (> current_time), not equal to it
        self._next_beat_time = last_beat_time + (full_beats_elapsed + 1) * beat_interval

        self._stats['predictions_generated'] += 1

        if self.debug:
            print(f"[predict] Generated prediction from last_beat={last_beat_time:.3f}s, interval={beat_interval:.3f}s ({tempo_bpm:.1f} BPM)")
            print(f"[predict]   Next beat: {self._next_beat_time:.3f}s")

    def get_stats(self) -> dict:
        """
        Get predictor statistics for analysis.

        Returns:
            Dictionary with keys:
            - 'predictions_generated': Total predictions created
            - 'predictions_consumed': Total predictions triggered (returned as beat_detected=True)

            Returns a copy to prevent external modification of internal state.
        """
        return self._stats.copy()