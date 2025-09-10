import pyaudio
import numpy as np
import time

class AudioCapturer:
    """A class to capture audio from the system's default input device."""

    def __init__(self, format=pyaudio.paInt16, channels=1, rate=44100, chunk=1024):
        """Initializes the AudioCapturer."""
        self.format = format
        self.channels = channels
        self.rate = rate
        self.chunk = chunk
        self.p = pyaudio.PyAudio()
        self.stream = None

    def start_stream(self):
        """Opens and starts the audio stream."""
        self.stream = self.p.open(format=self.format,
                                  channels=self.channels,
                                  rate=self.rate,
                                  input=True,
                                  frames_per_buffer=self.chunk)
        print("Audio stream started.")

    def stop_stream(self):
        """Stops and closes the audio stream."""
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
        self.p.terminate()
        print("Audio stream stopped.")

    def read_chunk(self):
        """Reads a chunk of audio data from the stream."""
        if self.stream:
            data = self.stream.read(self.chunk)
            return np.frombuffer(data, dtype=np.int16)
        return None

def main():
    """Main function to test audio capture."""
    capturer = AudioCapturer()
    
    capturer.start_stream()

    print("Recording... Press Ctrl+C to stop.")

    try:
        while True:
            audio_data = capturer.read_chunk()
            if audio_data is not None:
                rms = np.sqrt(np.mean(audio_data.astype(float)**2))
                print(f"RMS: {rms:.2f}")
            time.sleep(0.1)
    except KeyboardInterrupt:
        print("Stopping recording.")
    finally:
        capturer.stop_stream()

if __name__ == "__main__":
    main()
