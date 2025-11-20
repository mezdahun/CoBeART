#!/usr/bin/env python3
"""
Real-time audio visualization with rolling 5-second window.

Shows RMS and spectrogram (frequency content over time).
"""
import time
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from collections import deque
from cobeart.audiocapture.capture import AudioCapturer


class RMSVisualizer:
    """Real-time audio visualization with RMS and spectrogram."""

    def __init__(self, window_seconds=5.0, update_interval_ms=50):
        """
        Initialize audio visualizer.

        Args:
            window_seconds: Time window to display (default 5.0 seconds)
            update_interval_ms: Update interval in milliseconds (default 50ms = 20 FPS)
        """
        self.window_seconds = window_seconds
        self.update_interval_ms = update_interval_ms

        # Data storage (rolling window)
        self.times = deque()
        self.rms_values = deque()
        self.spectra = deque()  # Store full spectrum for each time point
        self.start_time = None

        # Audio capturer
        self.capturer = AudioCapturer(chunk_size=1024, spectrum_bins=128)
        self.spectrum_bins = 128

        # Setup plot with 2 subplots
        self.fig = plt.figure(figsize=(14, 10))
        gs = self.fig.add_gridspec(2, 1, height_ratios=[1, 2], hspace=0.3)
        self.ax_rms = self.fig.add_subplot(gs[0])
        self.ax_spec = self.fig.add_subplot(gs[1], sharex=self.ax_rms)
        
        # RMS subplot
        self.line_rms, = self.ax_rms.plot([], [], 'b-', linewidth=2, label='RMS Level')
        self.ax_rms.set_xlim(0, window_seconds)
        self.ax_rms.set_ylim(0, 0.5)
        self.ax_rms.set_ylabel('RMS Amplitude', fontsize=11)
        self.ax_rms.set_title('Real-Time Audio Analysis - Rolling 5 Second Window', 
                              fontsize=14, fontweight='bold')
        self.ax_rms.grid(True, alpha=0.3)
        self.ax_rms.legend(loc='upper right')
        
        # Spectrogram subplot
        # Initialize with empty data
        self.spectrogram_data = np.zeros((self.spectrum_bins, 1))
        self.spectrogram_image = self.ax_spec.imshow(
            self.spectrogram_data,
            aspect='auto',
            origin='lower',
            cmap='viridis',
            interpolation='bilinear',
            extent=[0, window_seconds, 0, self.spectrum_bins],
            vmin=0.0,
            vmax=1.0
        )
        
        self.ax_spec.set_xlabel('Time (seconds)', fontsize=12)
        self.ax_spec.set_ylabel('Frequency Bin', fontsize=11)
        self.ax_spec.set_xlim(0, window_seconds)
        self.ax_spec.set_ylim(0, self.spectrum_bins)
        
        # Add frequency labels on right side
        freq_min = self.capturer.freq_min
        freq_max = self.capturer.freq_max
        freq_ticks = [0, self.spectrum_bins // 4, self.spectrum_bins // 2, 
                      3 * self.spectrum_bins // 4, self.spectrum_bins - 1]
        freq_labels = []
        for tick in freq_ticks:
            # Calculate actual frequency for this bin (log scale)
            freq_ratio = tick / (self.spectrum_bins - 1)
            freq_hz = freq_min * (freq_max / freq_min) ** freq_ratio
            if freq_hz < 1000:
                freq_labels.append(f'{freq_hz:.0f}Hz')
            else:
                freq_labels.append(f'{freq_hz/1000:.1f}kHz')
        self.ax_spec.set_yticks(freq_ticks)
        self.ax_spec.set_yticklabels(freq_labels)
        
        # Add colorbar
        cbar = self.fig.colorbar(self.spectrogram_image, ax=self.ax_spec, pad=0.01)
        cbar.set_label('Magnitude', fontsize=10)
        
        plt.tight_layout()

    def _get_spectrum_db(self, data):
        """
        Compute FFT spectrum with dB normalization for visualization.
        
        This uses a proper dB scale with noise floor cutoff for better contrast.
        
        Args:
            data: Audio samples (numpy array)
            
        Returns:
            numpy array of shape (spectrum_bins,) with normalized magnitudes [0.0, 1.0]
        """
        n = len(data)
        if n == 0:
            return np.zeros(self.spectrum_bins, dtype=np.float32)
        
        # Apply window and compute FFT
        windowed = data * np.hanning(n)
        fft_result = np.fft.rfft(windowed)
        fft_freqs = np.fft.rfftfreq(n, 1.0 / self.capturer.sample_rate)
        fft_magnitudes = np.abs(fft_result)
        
        # Create logarithmically-spaced frequency bins
        log_freq_bins = np.logspace(
            np.log10(max(self.capturer.freq_min, 1.0)),
            np.log10(min(self.capturer.freq_max, self.capturer.sample_rate / 2)),
            self.spectrum_bins + 1
        )
        
        # Map FFT bins to our custom bins
        spectrum = np.zeros(self.spectrum_bins, dtype=np.float32)
        for i in range(self.spectrum_bins):
            freq_low = log_freq_bins[i]
            freq_high = log_freq_bins[i + 1]
            mask = (fft_freqs >= freq_low) & (fft_freqs < freq_high)
            
            if np.any(mask):
                spectrum[i] = np.mean(fft_magnitudes[mask])
        
        # Convert to dB scale with proper reference
        # Reference: use maximum possible value for normalization
        ref = np.max(spectrum) if np.max(spectrum) > 0 else 1.0
        spectrum_db = 20 * np.log10(spectrum / ref + 1e-10)
        
        # Map dB range to [0, 1] with noise floor cutoff
        # -60 dB to 0 dB -> [0, 1]
        db_min = -60.0
        db_max = 0.0
        spectrum_normalized = np.clip((spectrum_db - db_min) / (db_max - db_min), 0.0, 1.0)
        
        return spectrum_normalized

    def start(self):
        """Start audio capture and visualization."""
        print("Starting audio visualization...")
        print("Window: 5 seconds (rolling)")
        print("Showing: RMS (top) and Spectrogram (bottom)")
        print("Press Ctrl+C or close window to stop.")
        
        self.capturer.start_stream()
        self.start_time = time.time()
        
        # Start animation
        anim = FuncAnimation(
            self.fig,
            self.update,
            interval=self.update_interval_ms,
            blit=False,
            cache_frame_data=False
        )
        
        try:
            plt.show()
        except KeyboardInterrupt:
            print("\nStopping visualization...")
        finally:
            self.capturer.stop_stream()

    def update(self, frame):
        """Update plot with new data."""
        # Read audio chunk
        audio_data = self.capturer.read_chunk()
        
        if audio_data is not None and audio_data.size > 0:
            # Calculate RMS
            rms = self.capturer.get_rms(audio_data)
            
            # Calculate spectrum with better normalization for visualization
            spectrum = self._get_spectrum_db(audio_data)
            
            current_time = time.time() - self.start_time
            
            # Add to rolling window
            self.times.append(current_time)
            self.rms_values.append(rms)
            self.spectra.append(spectrum.copy())
            
            # Remove old data outside the window
            cutoff_time = current_time - self.window_seconds
            while len(self.times) > 0 and self.times[0] < cutoff_time:
                self.times.popleft()
                self.rms_values.popleft()
                self.spectra.popleft()
            
            # Update plot data
            if len(self.times) > 0:
                # Update RMS plot
                times_array = np.array(self.times)
                rms_array = np.array(self.rms_values)
                
                # Shift time axis to show rolling window
                display_times = times_array - (current_time - self.window_seconds)
                
                self.line_rms.set_data(display_times, rms_array)
                
                # Update x-axis to follow the rolling window
                self.ax_rms.set_xlim(0, self.window_seconds)
                
                # Auto-scale y-axis for RMS if needed
                if len(rms_array) > 0:
                    max_rms = np.max(rms_array)
                    if max_rms > self.ax_rms.get_ylim()[1] * 0.9:
                        self.ax_rms.set_ylim(0, max_rms * 1.2)
                
                # Update spectrogram
                # Build spectrogram matrix: rows are frequency bins, columns are time points
                spectra_array = np.array(self.spectra).T  # Transpose to get (freq_bins, time_points)
                
                # Update image data
                self.spectrogram_image.set_data(spectra_array)
                self.spectrogram_image.set_extent([0, self.window_seconds, 0, self.spectrum_bins])
        
        return self.line_rms, self.spectrogram_image


def main():
    """Run RMS visualizer."""
    visualizer = RMSVisualizer(window_seconds=5.0, update_interval_ms=50)
    visualizer.start()


if __name__ == "__main__":
    main()

