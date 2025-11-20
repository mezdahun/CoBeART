#!/usr/bin/env python3
"""
Test script for PredictiveBeatLayer with real audio capture.

Captures system audio and logs predicted vs actual beat timestamps
to a file for latency analysis.
"""

import time
import sys
from collections import deque
from cobeart.audiocapture.capture import AudioCapturer
from cobeart.audiocapture.beat.predictor import PredictiveBeatLayer


def test_predictive_layer_realtime(log_file="predictive_beat_test.log"):
    """
    Test predictive beat layer with real audio capture.

    Logs beat comparisons to file in real-time showing latency improvement.

    Args:
        log_file: Path to output log file
    """
    print("=" * 70)
    print("Predictive Beat Layer Test - Real Audio Capture")
    print("=" * 70)
    print()

    # Initialize audio capturer with beat detection
    print("Initializing audio capture with beat detection...")
    capturer = AudioCapturer(
        chunk_size=1024,
        enable_beat_detection=True
    )

    # Get beat detector reference
    detector = capturer._beat_detector
    if detector is None:
        print("ERROR: Beat detection not enabled")
        return

    # Create predictive layer
    print("Initializing predictive layer...")
    predictor = PredictiveBeatLayer(
        beat_detector=detector,
        poll_interval=0.05,
        debug=False
    )

    # Start audio capture
    print("Starting audio stream...")
    capturer.start_stream()

    # Give detector time to initialize
    print("Waiting for beat detector to warm up...")
    time.sleep(3)

    # Open log file
    log = open(log_file, 'w')
    log.write("Predictive Beat Layer Test - Real Audio Capture\n")
    log.write("=" * 80 + "\n")
    log.write(f"Started: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    log.write("=" * 80 + "\n\n")
    log.write(f"{'Beat#':<8} | {'Predicted Time':<17} | {'Actual Time':<17} | {'Diff (ms)':<12} | {'BPM':<8}\n")
    log.write("-" * 80 + "\n")
    log.flush()

    print(f"Logging to: {log_file}")
    print("Recording... Press Ctrl+C to stop")
    print()

    # Track state
    fired_predictions = []  # (predicted_timestamp, wall_time_fired) - predictions that have fired
    logged_beat_timestamps = set()  # Track which actual beats we've already logged
    beat_number = 0
    latencies = []

    try:
        while True:
            # Read audio chunk (keeps buffer filled)
            audio_data = capturer.read_chunk()

            # Check for predicted beats that FIRE (beat has arrived)
            predicted_beat, predicted_tempo, predicted_timestamp = predictor.get_next_beat()
            if predicted_beat and predicted_timestamp is not None:
                # Store this FIRED predicted beat with its timestamp
                fired_predictions.append((predicted_timestamp, time.time()))

            # Check for actual beats from detector
            with capturer._beat_lock:
                # Check all beats in history, process any we haven't logged yet
                for actual_timestamp in detector._beat_history:
                    # Skip if already logged
                    if actual_timestamp in logged_beat_timestamps:
                        continue

                    actual_bpm = capturer._current_tempo

                    # Find closest FIRED predicted beat (within ~100ms tolerance)
                    # The fired prediction should closely match the actual beat time
                    best_match = None
                    best_diff = float('inf')

                    for pred_timestamp, pred_wall_time in fired_predictions:
                        diff = abs(actual_timestamp - pred_timestamp)
                        if diff < best_diff and diff < 0.100:  # Within 100ms
                            best_diff = diff
                            best_match = (pred_timestamp, pred_wall_time)

                    # If we found a matching predicted beat
                    if best_match is not None:
                        pred_timestamp, pred_wall_time = best_match

                        # Calculate difference in milliseconds
                        # Negative = predicted beat timestamp was earlier (predictor is ahead)
                        # Positive = predicted beat timestamp was later (predictor is behind)
                        diff_ms = (pred_timestamp - actual_timestamp) * 1000

                        beat_number += 1
                        bpm_str = f"{actual_bpm:.1f}" if actual_bpm else "N/A"

                        # Write to log
                        log.write(f"{beat_number:<8} | {pred_timestamp:17.3f} | {actual_timestamp:17.3f} | {diff_ms:+12.1f} | {bpm_str:<8}\n")
                        log.flush()

                        latencies.append(diff_ms)

                        # Remove matched prediction from list
                        fired_predictions.remove(best_match)

                        # Mark this actual beat as logged
                        logged_beat_timestamps.add(actual_timestamp)

            # Small sleep to prevent busy-wait
            time.sleep(0.01)

    except KeyboardInterrupt:
        print("\nStopping capture...")

    # Stop audio
    capturer.stop_stream()

    # Write summary to log
    log.write("\n")
    log.write("=" * 80 + "\n")
    log.write("Summary\n")
    log.write("=" * 80 + "\n")
    log.write(f"Total beat pairs logged: {len(latencies)}\n")

    if len(latencies) > 0:
        import numpy as np
        log.write(f"\nTimestamp Difference Statistics:\n")
        log.write(f"  Mean:   {np.mean(latencies):+.1f} ms\n")
        log.write(f"  Median: {np.median(latencies):+.1f} ms\n")
        log.write(f"  Std:    {np.std(latencies):.1f} ms\n")
        log.write(f"  Min:    {np.min(latencies):+.1f} ms\n")
        log.write(f"  Max:    {np.max(latencies):+.1f} ms\n")
        log.write(f"\n")
        log.write(f"Interpretation:\n")
        log.write(f"  Negative difference = predictor timestamp was EARLIER than actual\n")
        log.write(f"  Positive difference = predictor timestamp was LATER than actual\n")
        log.write(f"  Near-zero mean = predictions are accurately aligned with actual beats\n")

    # Get predictor stats
    stats = predictor.get_stats()
    log.write(f"\nPredictor Statistics:\n")
    log.write(f"  Predictions generated: {stats['predictions_generated']}\n")
    log.write(f"  Predictions consumed:  {stats['predictions_consumed']}\n")

    log.write(f"\n")
    log.write(f"Ended: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    log.write("=" * 80 + "\n")
    log.close()

    # Print summary to console
    print()
    print("=" * 70)
    print("Test Complete")
    print("=" * 70)
    print(f"Beat pairs logged: {len(latencies)}")
    if len(latencies) > 0:
        print(f"Average timestamp difference: {np.mean(latencies):+.1f} ms")
        print(f"  (near-zero = predictions align well with actual beats)")
    print(f"\nFull results written to: {log_file}")
    print("=" * 70)


def main():
    """Run real-time test."""
    import argparse

    parser = argparse.ArgumentParser(description="Test predictive beat layer with real audio")
    parser.add_argument('--output', type=str, default='predictive_beat_test.log',
                        help='Output log file path')

    args = parser.parse_args()

    try:
        test_predictive_layer_realtime(log_file=args.output)
    except Exception as e:
        print(f"\nTest failed with error: {e}")
        raise


if __name__ == "__main__":
    main()
