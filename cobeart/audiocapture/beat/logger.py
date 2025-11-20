"""
Beat timestamp logger for offline analysis and performance profiling.

Logs detected beats to timestamped CSV-style file with timing metrics for
post-analysis. Each beat entry includes:
- Beat timestamp (absolute Unix time)
- Processing completion time
- Processing latency (detection lag behind actual beat time)
- Interval from previous beat
- Current BPM estimate
- Beat history size (1-8)
- Granular timing breakdown: total processing, resample, RNN, DBN

Output format: CSV-compatible with header comments
Filename pattern: beat_history_{YYYYMMDD_HHMMSS}.log

Supports context manager protocol for safe resource handling:
    with BeatLogger(enabled=True) as logger:
        logger.log_beat(...)
    # File automatically closed on exit

Manual lifecycle also supported:
    logger = BeatLogger(enabled=True)
    logger.log_beat(...)
    logger.close()

All writes flushed immediately for real-time monitoring (e.g., tail -f).
"""
import time
from pathlib import Path
from typing import Optional


class BeatLogger:
    """
    Logs beat timestamps to file for post-analysis.

    Creates log file with format: beat_history_{timestamp}.log
    Columns: timestamp, processing_time, latency, interval, bpm, history_size,
             processing_latency, resample, beat_proc, track_proc

    Implements context manager protocol (__enter__, __exit__) for automatic
    resource cleanup. Destructor (__del__) provides fallback cleanup if context
    manager not used.
    """

    def __init__(self, enabled: bool = False, log_dir: str = "."):
        """
        Initialize beat logger.

        Creates log file immediately if enabled=True, writes CSV-style header.
        Filename format: beat_history_{YYYYMMDD_HHMMSS}.log

        Args:
            enabled: Whether to enable logging (if False, all log_beat() calls are no-ops)
            log_dir: Directory to write log file (default: current directory)
        """
        self.enabled = enabled
        self.log_file = None
        self.log_path = None

        if enabled:
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            self.log_path = Path(log_dir) / f"beat_history_{timestamp}.log"
            self.log_file = open(self.log_path, 'w')
            self.log_file.write("# Beat History Log\n")
            self.log_file.write("# Format: beat_time(s), processing_time_since_start(s), latency(ms), interval_from_last(ms), bpm, history_size, processing_latency(ms), resample(ms), beat_proc(ms), track_proc(ms)\n")
            self.log_file.write("# Columns: timestamp, processing_time, latency, interval, bpm, history_size, processing_latency, resample, beat_proc, track_proc\n")
            print(f"[beat-logger] Logging to {self.log_path}")

    def log_beat(self, beat_time: float, processing_time_since_start: float, interval: Optional[float], bpm: Optional[float], history_size: int, processing_latency: float, timings: dict):
        """
        Log a beat timestamp with context.

        Writes single line to log file with comma-separated values, then flushes for
        immediate visibility. No-op if logger not enabled. Uses "---" placeholder for
        None values (interval on first beat, bpm when not yet calculated).

        Args:
            beat_time: Beat timestamp in seconds (absolute Unix time)
            processing_time_since_start: Time when processing completed, in seconds (absolute Unix time)
            interval: Interval from last beat in seconds (None if first beat)
            bpm: Current BPM estimate (None if <2 beats in history)
            history_size: Current size of beat history (1-8)
            processing_latency: Execution time of the process() function in seconds
            timings: Dictionary with granular timings ('resample', 'beat_proc', 'track_proc' keys)

        Performance: O(1) write + flush operation
        """
        if self.enabled and self.log_file:
            latency_ms = (processing_time_since_start - beat_time) * 1000
            interval_str = f"{interval*1000:.1f}" if interval is not None else "---"
            bpm_str = f"{bpm:.1f}" if bpm is not None else "---"

            # Group timing conversions to milliseconds
            timings_ms = {k: v * 1000 for k, v in timings.items()}

            self.log_file.write(
                f"{beat_time:.6f}, {processing_time_since_start:.6f}, {latency_ms:.3f}, "
                f"{interval_str}, {bpm_str}, {history_size}, "
                f"{processing_latency*1000:.3f}, {timings_ms.get('resample', 0.0):.3f}, "
                f"{timings_ms.get('beat_proc', 0.0):.3f}, {timings_ms.get('track_proc', 0.0):.3f}\n"
            )
            self.log_file.flush()  # Immediate write for real-time monitoring

    def close(self):
        """
        Close the log file.

        Safe to call multiple times (idempotent). Sets log_file to None after closing.
        """
        if self.log_file:
            self.log_file.close()
            self.log_file = None

    def __enter__(self):
        """
        Context manager entry.

        Returns:
            Self for use in with-statement
        """
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """
        Context manager exit - ensures file is closed.

        Args:
            exc_type: Exception type if exception occurred
            exc_val: Exception value if exception occurred
            exc_tb: Exception traceback if exception occurred

        Returns:
            False (does not suppress exceptions)
        """
        self.close()
        return False  # Don't suppress exceptions

    def __del__(self):
        """
        Destructor fallback to ensure file closure.

        Called when object is garbage collected. Provides safety net if user
        forgets to call close() or use context manager.
        """
        self.close()
