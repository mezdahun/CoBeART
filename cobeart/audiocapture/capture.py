import numpy as np
import time
from cobeart.audiocapture.utils import select_audio_device

class AudioCapturer:
    """A class to capture audio from a user-selected input device."""

    def __init__(self, chunk_size=1024, sample_rate=48000):
        """
        Initializes the AudioCapturer by selecting a device.
        A larger chunk_size (e.g., 1024) is better for frequency resolution of metrics.
        A smaller chunk_size (e.g., 512) is better for low-latency visualization.
        """
        self.mic = select_audio_device()
        self.chunk_size = chunk_size
        self.sample_rate = sample_rate
        self.recorder = None
        self.is_recording = False

    def start_stream(self):
        """Starts the audio recording stream."""
        if self.is_recording:
            print("Stream is already running.")
            return
        
        print("Audio stream started.")
        self.recorder = self.mic.recorder(samplerate=self.sample_rate, 
                                          channels=self.mic.channels, 
                                          blocksize=self.chunk_size)
        self.recorder.__enter__()
        self.is_recording = True

    def stop_stream(self):
        """Stops the audio recording stream."""
        if not self.is_recording:
            print("Stream is not running.")
            return

        self.recorder.__exit__(None, None, None)
        self.is_recording = False
        print("Audio stream stopped.")

    def read_chunk(self):
        """Reads a chunk of audio data from the stream."""
        if not self.is_recording or self.recorder is None:
            return None
        
        data = self.recorder.record(numframes=self.chunk_size)
        # Return the first channel if multi-channel
        return data[:, 0] if data.ndim > 1 else data

    def get_rms(self, data):
        """Calculates the RMS of a chunk of audio data."""
        return np.sqrt(np.mean(data**2))

    def get_peak_amplitude(self, data):
        """Gets the peak amplitude of a chunk of audio data."""
        return np.max(np.abs(data))

    def get_zero_crossing_rate(self, data):
        """Calculates the zero-crossing rate of a chunk of audio data."""
        return np.sum(np.diff(np.signbit(data))) / len(data)

    def get_dominant_frequency(self, data):
        """Calculates the dominant frequency of a chunk of audio data using FFT."""
        fft_data = np.fft.rfft(data)
        freqs = np.fft.rfftfreq(len(data), 1 / self.sample_rate)
        dominant_frequency = freqs[np.argmax(np.abs(fft_data))]
        return dominant_frequency

def main():
    """Main function to test audio capture and metrics."""
    # Use 1024 as the default for metrics to get better frequency resolution.
    capturer = AudioCapturer(chunk_size=1024)
    capturer.start_stream()

    print("Reading audio metrics... Press Ctrl+C to stop.")

    try:
        while True:
            audio_data = capturer.read_chunk()
            if audio_data is not None and audio_data.size > 0:
                rms = capturer.get_rms(audio_data)
                peak = capturer.get_peak_amplitude(audio_data)
                zcr = capturer.get_zero_crossing_rate(audio_data)
                dom_freq = capturer.get_dominant_frequency(audio_data)

                # Use carriage return to print on the same line for a cleaner output
                print(f"RMS: {rms:.4f} | Peak: {peak:.4f} | ZCR: {zcr:.4f} | Dominant Freq: {dom_freq:.2f} Hz  ", end='\r')
            
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
