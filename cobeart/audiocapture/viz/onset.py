#!/usr/bin/env python3
"""Real-time graphical visualization of onset detection."""

import time
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.animation as animation
from collections import deque
from cobeart.audiocapture.capture import AudioCapturer


class OnsetVisualizer:
    def __init__(self, history_seconds=10, sample_rate_hz=30):
        """
        Initialize the onset visualizer.

        Args:
            history_seconds: How many seconds of history to display
            sample_rate_hz: Update rate in Hz (should match audio processing rate)
        """
        self.history_size = int(history_seconds * sample_rate_hz)
        self.sample_rate_hz = sample_rate_hz

        # Data buffers
        self.onset_history = deque(maxlen=self.history_size)
        self.onset_strength_history = deque(maxlen=self.history_size)
        self.peak_history = deque(maxlen=self.history_size)
        self.rms_envelope_history = deque(maxlen=self.history_size)
        self.time_history = deque(maxlen=self.history_size)

        # Initialize with zeros
        for _ in range(self.history_size):
            self.onset_history.append(0)
            self.onset_strength_history.append(0)
            self.peak_history.append(0)
            self.rms_envelope_history.append(0)
            self.time_history.append(0)

        # Create figure and subplots
        self.fig, (self.ax1, self.ax2, self.ax3) = plt.subplots(3, 1, figsize=(12, 8))
        self.fig.suptitle('Real-time Audio Analysis', fontsize=14, fontweight='bold')

        # Setup RMS Envelope plot
        self.ax1.set_ylabel('RMS Envelope', fontsize=10)
        self.ax1.set_ylim(0, 1.0)
        self.ax1.grid(True, alpha=0.3)
        self.line_envelope, = self.ax1.plot([], [], 'g-', linewidth=2, label='Envelope')
        self.ax1.legend(loc='upper right')
        self.ax1.set_xlim(-history_seconds, 0)

        # Setup Onset Strength plot
        self.ax2.set_ylabel('Onset Strength', fontsize=10)
        self.ax2.set_ylim(0, 3.0)
        self.ax2.grid(True, alpha=0.3)
        self.line_onset_strength, = self.ax2.plot([], [], 'b-', linewidth=1.5, alpha=0.7, label='Strength')
        # Add threshold line
        self.ax2.axhline(y=1.0, color='r', linestyle='--', alpha=0.5, label='Threshold')
        self.ax2.legend(loc='upper right')
        self.ax2.set_xlim(-history_seconds, 0)

        # Setup Onset Events plot (stem plot)
        self.ax3.set_xlabel('Time (seconds)', fontsize=10)
        self.ax3.set_ylabel('Events', fontsize=10)
        self.ax3.set_ylim(-0.5, 2.5)
        self.ax3.set_yticks([0, 1, 2])
        self.ax3.set_yticklabels(['', 'Onset', 'Peak'])
        self.ax3.grid(True, alpha=0.3, axis='x')
        self.ax3.set_xlim(-history_seconds, 0)

        # We'll use scatter for events (faster than stem for real-time)
        self.scatter_onsets = self.ax3.scatter([], [], c='blue', marker='|', s=500, alpha=0.8, label='Onset')
        self.scatter_peaks = self.ax3.scatter([], [], c='red', marker='|', s=500, alpha=0.8, label='Peak')
        self.ax3.legend(loc='upper right')

        plt.tight_layout()

        # Audio capturer
        self.capturer = AudioCapturer(chunk_size=1024)
        self.start_time = None

    def update_data(self):
        """Read audio and update data buffers."""
        audio_data = self.capturer.read_chunk()
        if audio_data is None or audio_data.size == 0:
            return

        if self.start_time is None:
            self.start_time = time.time()

        current_time = time.time() - self.start_time

        # Calculate metrics
        rms = self.capturer.get_rms(audio_data)
        rms_db = self.capturer.get_rms_db(audio_data)
        rms_envelope = self.capturer.get_rms_envelope(rms_db)
        is_peak, peak_intensity = self.capturer.detect_rms_peak(rms)
        is_onset, onset_strength = self.capturer.detect_onset(audio_data)

        # Update buffers
        self.time_history.append(current_time)
        self.rms_envelope_history.append(rms_envelope)
        self.onset_strength_history.append(onset_strength)
        self.onset_history.append(1 if is_onset else 0)
        self.peak_history.append(1 if is_peak else 0)

    def animate(self, frame):
        """Animation update function."""
        self.update_data()

        # Create relative time array (seconds ago)
        if self.start_time is None:
            return self.line_envelope, self.line_onset_strength, self.scatter_onsets, self.scatter_peaks

        current_time = time.time() - self.start_time
        time_array = np.array(self.time_history) - current_time

        # Update RMS Envelope
        self.line_envelope.set_data(time_array, np.array(self.rms_envelope_history))

        # Update Onset Strength
        self.line_onset_strength.set_data(time_array, np.array(self.onset_strength_history))

        # Update Onset Events (only show actual events)
        onset_times = time_array[np.array(self.onset_history) > 0]
        onset_y = np.ones_like(onset_times)
        self.scatter_onsets.set_offsets(np.c_[onset_times, onset_y])

        # Update Peak Events
        peak_times = time_array[np.array(self.peak_history) > 0]
        peak_y = np.ones_like(peak_times) * 2
        self.scatter_peaks.set_offsets(np.c_[peak_times, peak_y])

        return self.line_envelope, self.line_onset_strength, self.scatter_onsets, self.scatter_peaks

    def run(self):
        """Start the visualization."""
        print("Starting onset visualizer...")
        print("Close the window or press Ctrl+C to stop.\n")

        self.capturer.start_stream()

        # Create animation
        # interval in ms = 1000 / sample_rate_hz
        interval_ms = int(1000 / self.sample_rate_hz)

        ani = animation.FuncAnimation(
            self.fig,
            self.animate,
            interval=interval_ms,
            blit=True,
            cache_frame_data=False
        )

        try:
            plt.show()
        except KeyboardInterrupt:
            print("\nStopping visualization...")
        finally:
            self.capturer.stop_stream()
            print("Visualization stopped.")


def main():
    visualizer = OnsetVisualizer(history_seconds=10, sample_rate_hz=30)
    visualizer.run()


if __name__ == "__main__":
    main()
