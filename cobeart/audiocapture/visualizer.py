import soundcard as sc
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from cobeart.audiocapture.utils import select_audio_device
import warnings
import threading

# NumPy 2.x compatibility for soundcard backend: redirect deprecated binary fromstring to frombuffer
try:
    import soundcard.mediafoundation as _sc_mf  # type: ignore
    _sc_mf.numpy.fromstring = np.frombuffer  # type: ignore[attr-defined]
except Exception:
    pass

def main():
    """Sets up and runs a low-latency audio visualizer using Matplotlib."""
    mic = select_audio_device()
    # Prefer device default samplerate if available to avoid resampling.
    try:
        samplerate = sc.default_samplerate()
    except Exception:
        samplerate = 48000
    # Choose device-friendly capture and plot sizes.
    base10 = int(round(samplerate / 100))  # ~10 ms blocks ≈ device period
    CAPTURE_FRAMES = max(base10, 240)      # capture in ~10 ms blocks
    CHUNK = max(base10 * 4, 960)           # plot ~40 ms window

    # Reduce warning spam for occasional glitches from the backend.
    warnings.filterwarnings(
        "once",
        message="data discontinuity in recording",
        module="soundcard.mediafoundation",
    )

    # --- Matplotlib plotting ---
    plt.style.use('fast')
    fig, ax = plt.subplots()
    x = np.arange(0, CHUNK)
    plot_buffer = np.zeros(CHUNK, dtype=np.float32)
    line, = ax.plot(x, plot_buffer, lw=1, antialiased=False)
    ax.set_ylim(-1.0, 1.0)
    ax.set_xlim(0, CHUNK)
    ax.set_title("Real-time Audio Waveform")
    ax.set_xlabel("Samples")
    ax.set_ylabel("Amplitude")

    # --- Audio Recording (decoupled capture thread) ---
    stop_event = threading.Event()
    ring = np.zeros(CHUNK, dtype=np.float32)
    ring_lock = threading.Lock()

    def capture_loop():
        try:
            with mic.recorder(samplerate=samplerate, channels=[0], blocksize=CAPTURE_FRAMES) as recorder:
                while not stop_event.is_set():
                    data = recorder.record(numframes=CAPTURE_FRAMES)
                    if data is not None:
                        block = data.reshape(-1)
                        with ring_lock:
                            # slide left and append new block to the end
                            n = min(len(block), CHUNK)
                            if n < CHUNK:
                                ring[:-n] = ring[n:]
                                ring[-n:] = block[:n]
                            else:
                                ring[:] = block[-CHUNK:]
        except Exception:
            # Swallow to allow graceful shutdown; visualizer is best-effort.
            pass

    capture_thread = threading.Thread(target=capture_loop, name="audio-capture", daemon=True)
    capture_thread.start()

    def update_plot(frame):
        """Called by FuncAnimation. Updates the plot with the latest captured audio."""
        with ring_lock:
            plot_buffer[:] = ring
        line.set_ydata(plot_buffer)
        return line,

    print("\nStarting visualizer... Close the plot window to stop.")

    ani = FuncAnimation(fig, update_plot, init_func=lambda: (line,), blit=False, interval=1, save_count=0, cache_frame_data=False)
    def _on_close(event):
        stop_event.set()
    fig.canvas.mpl_connect('close_event', _on_close)

    plt.show()

    # --- Cleanup ---
    stop_event.set()
    capture_thread.join(timeout=1.0)
    print("\nVisualizer stopped.")

if __name__ == '__main__':
    main()
