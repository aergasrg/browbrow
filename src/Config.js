// Tunable constants shared across the app. Frequencies are in Hz unless the
// name says Bpm (beats or breaths per minute).

/** Rate every color trace is resampled to, so the math sees evenly spaced samples. */
export const SampleRate = 30;

/** Heart-rate search band. */
export const MinBpm = 42;
export const MaxBpm = 240;

/** Default length of the window the heart rate is estimated over. */
export const DefaultWindowSeconds = 10;

/** Seconds of clean signal needed before the first reading is shown. */
export const CalibrationSeconds = 7;

/** POS / CHROM sliding window (about one heartbeat at low rates, per Wang et al. 2017). */
export const PulseWindowSeconds = 1.6;

/** How often the heart rate is re-estimated. */
export const EstimateIntervalSeconds = 0.5;

/** How often breathing and HRV are re-estimated. */
export const SlowEstimateIntervalSeconds = 2;

/** Seconds of pulse waveform kept ready for the monitor strip. */
export const WaveSeconds = 8;

/** Gap in camera samples after which the traces restart (face lost, tab hidden). */
export const MaxGapSeconds = 1;

/** Seconds of per-sample traces kept in memory for analysis. */
export const TraceHistorySeconds = 90;

/** Longest session kept for export; older raw samples are dropped. */
export const MaxSessionSeconds = 60 * 60;

/** Breathing search band, breaths per minute. */
export const MinBreathsPerMinute = 6;
export const MaxBreathsPerMinute = 30;
export const RespirationWindowSeconds = 32;
export const RespirationMinSeconds = 20;

/** HRV uses beats from this many recent seconds. */
export const HrvWindowSeconds = 60;
export const HrvMinBeats = 30;

/** Relative pulsatile strength per channel for blood volume changes (de Haan & van Leest 2014). */
export const BloodVolumePulse = [0.33, 0.77, 0.53];
