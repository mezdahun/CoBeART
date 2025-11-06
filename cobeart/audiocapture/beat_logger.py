"""
Simple beat timestamp logger for analysis.

Logs every beat added to beat_history with actual timestamps and intervals,
allowing offline analysis of beat detection accuracy independent of display logic.
"""
import time
from pathlib import Path
from typing import Optional


class BeatLogger:
    """Logs beat timestamps to file for post-analysis."""

    def __init__(self, enabled: bool = False, log_dir: str = "."):
        """
        Initialize beat logger.

        Args:
            enabled: Whether to enable logging
            log_dir: Directory to write log file
        """
        self.enabled = enabled
        self.log_file = None

        if enabled:
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            log_path = Path(log_dir) / f"beat_history_{timestamp}.log"
            self.log_file = open(log_path, 'w')
            self.log_file.write("# Beat History Log\n")
            self.log_file.write("# Format: beat_time(s), processing_time_since_start(s), latency(ms), interval_from_last(ms), bpm, history_size, processing_latency(ms), resample(ms), beat_proc(ms), track_proc(ms)\n")
            self.log_file.write("# Columns: timestamp, processing_time, latency, interval, bpm, history_size, processing_latency, resample, beat_proc, track_proc\n")
            print(f"[beat-logger] Logging to {log_path}")

    def log_beat(self, beat_time: float, processing_time_since_start: float, interval: Optional[float], bpm: Optional[float], history_size: int, processing_latency: float, timings: dict):
        """
        Log a beat timestamp with context.

        Args:
            beat_time: Beat timestamp in seconds
            processing_time_since_start: Time since processing started, in seconds
            interval: Interval from last beat in seconds (None if first beat)
            bpm: Current BPM estimate (None if not yet calculated)
            history_size: Current size of beat history
            processing_latency: Execution time of the process() function in seconds
            timings: Dictionary with granular timings
        """
        if self.enabled and self.log_file:
            latency_ms = (processing_time_since_start - beat_time) * 1000
            interval_str = f"{interval*1000:.1f}" if interval is not None else "---"
            bpm_str = f"{bpm:.1f}" if bpm is not None else "---"
            processing_latency_ms = processing_latency * 1000
            resample_ms = timings.get('resample', 0.0) * 1000
            beat_proc_ms = timings.get('beat_proc', 0.0) * 1000
            track_proc_ms = timings.get('track_proc', 0.0) * 1000
            self.log_file.write(f"{beat_time:.6f}, {processing_time_since_start:.6f}, {latency_ms:.3f}, {interval_str}, {bpm_str}, {history_size}, {processing_latency_ms:.3f}, {resample_ms:.3f}, {beat_proc_ms:.3f}, {track_proc_ms:.3f}\n")
            self.log_file.flush()  # Immediate write for real-time monitoring

    def close(self):
        """Close the log file."""
        if self.log_file:
            self.log_file.close()
            self.log_file = None
