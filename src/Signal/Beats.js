// Beat detection on the filtered pulse waveform, and heart rate variability
// from the time between beats.

import { MaxBpm, MinBpm } from '../Config.js';
import { mean, median, std } from './Stats.js';

/**
 * Local maxima above a threshold, at least MinInterval apart, refined to
 * sub-sample position with parabolic interpolation.
 * @param {ArrayLike<number>} Signal
 * @param {number} MinIntervalSamples
 * @param {number} Threshold
 * @returns {{ Position: number, Value: number }[]}
 */
export function findPeaks(Signal, MinIntervalSamples, Threshold) {
  /** @type {{ Position: number, Value: number }[]} */
  const Candidates = [];
  for (let Index = 1; Index < Signal.length - 1; Index++) {
    const Value = Signal[Index];
    if (Value < Threshold || Value <= Signal[Index - 1] || Value < Signal[Index + 1]) continue;
    const Left = Signal[Index - 1];
    const Right = Signal[Index + 1];
    const Denominator = Left - 2 * Value + Right;
    const Shift = Denominator < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (Left - Right)) / Denominator)) : 0;
    Candidates.push({ Position: Index + Shift, Value });
  }
  // Keep the tallest peaks first, dropping any that crowd a taller one.
  const ByHeight = [...Candidates].sort((A, B) => B.Value - A.Value);
  /** @type {{ Position: number, Value: number }[]} */
  const Kept = [];
  for (const Candidate of ByHeight) {
    if (Kept.every((Peak) => Math.abs(Peak.Position - Candidate.Position) >= MinIntervalSamples)) Kept.push(Candidate);
  }
  return Kept.sort((A, B) => A.Position - B.Position);
}

/**
 * Turns peaks found in a sliding window into a stable list of beat times.
 * The newest part of a zero-phase filtered window still changes as samples
 * arrive, so a peak is only confirmed once it is ConfirmDelay seconds old.
 */
export class BeatTracker {
  constructor(ConfirmDelay = 0.45) {
    this.ConfirmDelay = ConfirmDelay;
    /** @type {number[]} */
    this.Beats = [];
  }

  reset() {
    this.Beats = [];
  }

  /**
   * @param {ArrayLike<number>} Signal Normalized, band-passed pulse window.
   * @param {number} StartTime Time of Signal[0], seconds.
   * @param {number} SampleRate
   * @param {number} Now Time of the newest sample.
   * @param {number | null} Bpm Current heart-rate estimate, sets the minimum beat spacing.
   * @returns {number[]} Newly confirmed beat times.
   */
  update(Signal, StartTime, SampleRate, Now, Bpm) {
    const Period = Bpm ? 60 / Bpm : 60 / MaxBpm;
    const MinInterval = Bpm ? 0.6 * Period : 60 / MaxBpm;
    const Spread = std(Signal);
    const Peaks = findPeaks(Signal, MinInterval * SampleRate, 0.25 * Spread);
    const Last = this.Beats.length ? this.Beats[this.Beats.length - 1] : -Infinity;
    const EarliestUsable = StartTime + 0.5; // Stay clear of the left edge's filter transient.
    /** @type {number[]} */
    const Confirmed = [];
    for (const Peak of Peaks) {
      const Time = StartTime + Peak.Position / SampleRate;
      if (Time < EarliestUsable || Time > Now - this.ConfirmDelay) continue;
      const Previous = Confirmed.length ? Confirmed[Confirmed.length - 1] : Last;
      if (Time - Previous < MinInterval) continue;
      Confirmed.push(Time);
    }
    this.Beats.push(...Confirmed);
    if (this.Beats.length > 20000) this.Beats.splice(0, this.Beats.length - 20000);
    return Confirmed;
  }
}

/**
 * @typedef {object} HrvResult
 * @property {number} Rmssd Root mean square of successive beat-interval differences, ms.
 * @property {number} Sdnn Standard deviation of beat intervals, ms.
 * @property {number} MeanIbi Mean beat interval, ms.
 * @property {number} ValidBeats Intervals that passed artifact rejection.
 * @property {[number, number][]} Pairs Successive interval pairs (ms) for a Poincaré plot.
 */

/**
 * Time-domain HRV from beat times, rejecting intervals that are implausible or
 * far from the local median (missed or extra beats).
 * @param {number[]} BeatTimes Seconds, ascending.
 * @param {number} WindowSeconds Only beats in the last WindowSeconds are used.
 * @returns {HrvResult | null}
 */
export function computeHrv(BeatTimes, WindowSeconds) {
  if (BeatTimes.length < 3) return null;
  const Newest = BeatTimes[BeatTimes.length - 1];
  const Recent = BeatTimes.filter((Time) => Time >= Newest - WindowSeconds);
  /** @type {number[]} */
  const Intervals = [];
  for (let Index = 1; Index < Recent.length; Index++) Intervals.push(Recent[Index] - Recent[Index - 1]);
  const Typical = median(Intervals);
  const Valid = Intervals.map(
    (Interval) =>
      Interval >= 60 / MaxBpm && Interval <= 60 / MinBpm && Math.abs(Interval - Typical) <= 0.25 * Typical
  );
  const Kept = Intervals.filter((_, Index) => Valid[Index]).map((Interval) => Interval * 1000);
  if (Kept.length < 2) return null;
  /** @type {number[]} */
  const Differences = [];
  /** @type {[number, number][]} */
  const Pairs = [];
  for (let Index = 1; Index < Intervals.length; Index++) {
    if (!Valid[Index] || !Valid[Index - 1]) continue;
    const Previous = Intervals[Index - 1] * 1000;
    const Current = Intervals[Index] * 1000;
    Differences.push(Current - Previous);
    Pairs.push([Previous, Current]);
  }
  const Rmssd = Differences.length ? Math.sqrt(mean(Differences.map((Delta) => Delta * Delta))) : 0;
  return { Rmssd, Sdnn: std(Kept), MeanIbi: mean(Kept), ValidBeats: Kept.length, Pairs };
}
