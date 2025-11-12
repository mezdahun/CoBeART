#!/usr/bin/env python3
"""Test script for new audio-reactive features in AudioCapturer."""

import time
from cobeart.audiocapture.capture import AudioCapturer


def main():
    print("=" * 70)
    print("Audio-Reactive Features Test")
    print("=" * 70)
    print("\nThis script tests the new audio analysis features:")
    print("  - RMS dB scaling")
    print("  - RMS envelope (attack/decay)")
    print("  - Peak detection")
    print("  - Onset detection")
    print("\nPlay some music with varying dynamics to see the features in action!")
    print("Press Ctrl+C to stop.\n")

    # Create capturer with default settings
    capturer = AudioCapturer(chunk_size=1024)
    capturer.start_stream()

    try:
        while True:
            audio_data = capturer.read_chunk()
            if audio_data is not None and audio_data.size > 0:
                # Calculate all metrics
                rms = capturer.get_rms(audio_data)
                rms_db = capturer.get_rms_db(audio_data)
                rms_envelope = capturer.get_rms_envelope(rms_db)
                is_peak, peak_intensity = capturer.detect_rms_peak(rms)
                is_onset, onset_strength = capturer.detect_onset(audio_data)

                # Create visual indicators (persistent for visibility)
                peak_indicator = "⚡ PEAK " if is_peak else "       "
                onset_indicator = "🔊 ONSET" if is_onset else "       "

                # Create bar visualizations
                envelope_bar = "█" * int(rms_envelope * 40)
                peak_bar = "▓" * min(int(peak_intensity * 20), 20)
                onset_bar = "▒" * min(int(onset_strength * 10), 10)

                # Print metrics with fixed-width formatting to prevent jumping
                print(
                    f"\rRMS: {rms:.4f} | dB: {rms_db:.3f} | Env: {rms_envelope:.3f} |{envelope_bar:<40}|"
                    f"  {peak_indicator} Int: {peak_intensity:5.2f} |{peak_bar:<20}|"
                    f"  {onset_indicator} Str: {onset_strength:5.2f} |{onset_bar:<10}|",
                    end='', flush=True
                )

            # Sleep to match typical audio processing rate (~30 Hz)
            time.sleep(0.033)

    except KeyboardInterrupt:
        print("\n\nStopping test...")
    finally:
        capturer.stop_stream()
        print("Test completed.")


if __name__ == "__main__":
    main()
