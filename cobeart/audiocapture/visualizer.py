import soundcard as sc
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from cobeart.audiocapture.utils import select_audio_device

def main():
    """Sets up and runs a low-latency audio visualizer using Matplotlib."""
    mic = select_audio_device()
    # Use a smaller chunk size for lower latency in the visualizer.
    CHUNK = 512
    samplerate = 48000

    # --- Matplotlib plotting ---
    fig, ax = plt.subplots()
    x = np.arange(0, CHUNK)
    line, = ax.plot(x, np.zeros(CHUNK))
    ax.set_ylim(-1.0, 1.0)
    ax.set_xlim(0, CHUNK)
    ax.set_title("Real-time Audio Waveform")
    ax.set_xlabel("Samples")
    ax.set_ylabel("Amplitude")

    # --- Audio Recording and Animation ---
    # The animation loop runs with a very short interval. The actual frame rate will be
    # throttled by the blocking recorder.record() call, which waits for the next
    # chunk of audio. This is the key to low-latency performance.
    
    recorder = mic.recorder(samplerate=samplerate, channels=mic.channels, blocksize=CHUNK)
    recorder.__enter__() # Manually enter the context

    def update_plot(frame):
        """Called by FuncAnimation. Records audio and updates the plot."""
        data = recorder.record(numframes=CHUNK)
        
        if data is not None:
            plot_data = data[:, 0] if data.ndim > 1 else data
            line.set_ydata(plot_data)
        return line,

    print("\nStarting visualizer... Close the plot window to stop.")

    ani = FuncAnimation(fig, update_plot, blit=True, interval=1, save_count=0)
    plt.show()

    # --- Cleanup ---
    recorder.__exit__(None, None, None) # Manually exit the context
    print("\nVisualizer stopped.")

if __name__ == '__main__':
    main()
