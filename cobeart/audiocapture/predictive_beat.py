import time
import numpy as np
from typing import Tuple, Optional


class PredictiveBeatLayer:
    """
    Predictive beat layer that reduces latency by extrapolating the next beat.

    Polls a BeatDetector for stable tempo information and generates a single
    predicted beat timestamp. This allows the system to trigger beat events in
    real-time rather than waiting for the detector's processing latency (~169ms).

    Architecture:
    - When no prediction: polls detector at 50ms intervals (20 Hz)
    - When stable tempo detected: generates single predicted beat
    - When predicted beat reached: triggers immediately, then generates next
    - When tempo unstable: clears prediction and continues polling
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
            beat_detector: BeatDetector instance to poll for tempo state
            poll_interval: Polling interval in seconds when no prediction (default 0.05s = 20 Hz)
            debug: Enable debug logging
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

        This is the main API method called regularly (e.g., at audio frame rate).
        Handles polling, prediction consumption, and generation automatically.

        Returns:
            Tuple of (beat_detected, tempo_bpm, beat_timestamp)
            - beat_detected: True if current time has reached a predicted beat
            - tempo_bpm: Current tempo estimate (None if no stable tempo)
            - beat_timestamp: Predicted beat timestamp when beat_detected=True (None otherwise)
        """
        current_time = time.time()

        print(f"[predict] Start Time: {current_time:.3f}s")

        # Check if we have a prediction
        if self._next_beat_time is not None:
            print(f"[predict] Has Prediction")
            print(f"[predict] Next Beat Time: {self._next_beat_time:.3f}s")

            # Check if current time has reached the prediction
            if current_time >= self._next_beat_time:
                print(f"[predict] Current Time >= Next Beat Time, CONSUME BEAT")
                self._stats['predictions_consumed'] += 1

                beat_time = self._next_beat_time
                self._next_beat_time = None

                return True, self._current_tempo, beat_time
          
            print(f"[predict] Current Time < Next Beat Time, NOT YET")
            # Not yet time for next beat
            return False, self._current_tempo, None

        else:
            print(f"[predict] No Prediction queued")
            # No prediction - poll detector if enough time has passed
            if current_time - self._last_poll_time >= self._poll_interval:
                print(f"[predict] Poll Interval Passed, POLLING DETECTOR")
                last_beat_time, beat_interval, tempo_bpm = self._poll_detector()
                if last_beat_time is not None:
                    print(f"[predict] Detector Reported Stable Tempo, GENERATE PREDICTION")
                    self._generate_prediction(last_beat_time, beat_interval, tempo_bpm)
                    return False, tempo_bpm, last_beat_time
                else:
                    print(f"[predict] Detector Reported Unstable Tempo, NO PREDICTION")
            else:
                print(f"[predict] Poll Interval Not Passed, NOT POLLING DETECTOR")
            return False, None, None

    def _poll_detector(self) -> Tuple[Optional[float], Optional[float], Optional[float]]:
        """
        Poll the beat detector for stable tempo state.

        If detector reports stable tempo, generates predicted beat.
        If detector reports unstable (None), clears any stale prediction.

        Returns:
            Tuple of (last_beat_time, beat_interval, tempo_bpm) or (None, None, None) if unstable
        """
        self._last_poll_time = time.time()

        # Query detector for prediction state and unpack it
        state = self._detector.get_prediction_state()
        last_beat_time, beat_interval, tempo_bpm = state
        
        return last_beat_time, beat_interval, tempo_bpm

    def _generate_prediction(
        self,
        last_beat_time: float,
        beat_interval: float,
        tempo_bpm: float
    ) -> None:
        """
        Generate next predicted beat timestamp.

        Args:
            last_beat_time: Timestamp of last actual beat from detector
            beat_interval: Time interval between beats (seconds)
            tempo_bpm: Current tempo in BPM
        """
        # Store current tempo state
        self._current_tempo = tempo_bpm

        # Generate next beat
        next_beat = last_beat_time
        while next_beat < time.time():
            next_beat += beat_interval

        self._next_beat_time = next_beat

        self._stats['predictions_generated'] += 1

        if self.debug:
            print(f"[predict] Generated prediction from last_beat={last_beat_time:.3f}s, interval={beat_interval:.3f}s ({tempo_bpm:.1f} BPM)")
            print(f"[predict]   Next beat: {self._next_beat_time:.3f}s")

    def get_stats(self) -> dict:
        """
        Get predictor statistics.

        Returns:
            Dictionary with prediction statistics
        """
        return self._stats.copy()