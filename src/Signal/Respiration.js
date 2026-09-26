// Breathing rate (experimental). Breathing shows up two ways on camera: the
// head rises and falls slightly, and skin brightness drifts with each breath
// (respiratory-induced intensity variation). Both are measured and their
// spectra combined.

import { MaxBreathsPerMinute, MinBreathsPerMinute } from '../Config.js';
import { bandpass, decimate, detrend, filtfilt } from './Filters.js';
import { getFft } from './Fft.js';
import { clamp, std } from './Stats.js';

const Factor = 10; // 30 Hz -> 3 Hz is plenty for breathing.
const FftSize = 1024;

/**
 * @typedef {object} RespirationResult
 * @property {number} Rate Breaths per minute.
 * @property {number} Confidence 0..1.
 * @property {Float64Array} Wave Filtered breathing wave at the reduced rate, normalized.
 * @property {number} WaveRate Sample rate of Wave.
 */

/**
 * @param {ArrayLike<number>[]} Sources Evenly sampled traces covering the same time span.
 * @param {number} SampleRate
 * @param {number[]} [Weights] How much each source counts; defaults to equal.
 * @returns {RespirationResult | null}
 */
export function estimateRespiration(Sources, SampleRate, Weights = Sources.map(() => 1)) {
  const LowRate = SampleRate / Factor;
  const Sections = bandpass(MinBreathsPerMinute / 60, MaxBreathsPerMinute / 60, LowRate);
  const FirstBin = Math.ceil((MinBreathsPerMinute / 60) * (FftSize / LowRate));
  const LastBin = Math.floor((MaxBreathsPerMinute / 60) * (FftSize / LowRate));
  const Combined = new Float64Array(LastBin - FirstBin + 1);
  /** @type {Float64Array | null} */
  let BestWave = null;
  let BestPeakiness = -1;

  for (let SourceIndex = 0; SourceIndex < Sources.length; SourceIndex++) {
    const Weight = Weights[SourceIndex] ?? 1;
    const Low = decimate(Sources[SourceIndex], Factor);
    if (Low.length < 16) return null;
    const Filtered = filtfilt(Sections, detrend(Low), Low.length - 1);
    const Spread = std(Filtered);
    if (!(Spread > 0)) continue;
    const Re = new Float64Array(FftSize);
    const Im = new Float64Array(FftSize);
    for (let Index = 0; Index < Filtered.length && Index < FftSize; Index++) {
      const Hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * Index) / (Filtered.length - 1));
      Re[Index] = (Filtered[Index] / Spread) * Hann;
    }
    getFft(FftSize).transform(Re, Im);
    const Power = new Float64Array(Combined.length);
    let Total = 0;
    let Peak = 0;
    for (let Bin = 0; Bin < Power.length; Bin++) {
      const K = FirstBin + Bin;
      Power[Bin] = Re[K] * Re[K] + Im[K] * Im[K];
      Total += Power[Bin];
      Peak = Math.max(Peak, Power[Bin]);
    }
    if (Total <= 0) continue;
    for (let Bin = 0; Bin < Power.length; Bin++) Combined[Bin] += (Weight * Power[Bin]) / Total;
    const Peakiness = Weight * (Peak / Total) * Power.length;
    if (Peakiness > BestPeakiness) {
      BestPeakiness = Peakiness;
      BestWave = Filtered.map((Value) => Value / Spread);
    }
  }
  if (!BestWave) return null;

  let BestBin = 0;
  let Total = 0;
  for (let Bin = 0; Bin < Combined.length; Bin++) {
    Total += Combined[Bin];
    if (Combined[Bin] > Combined[BestBin]) BestBin = Bin;
  }
  let Shift = 0;
  if (BestBin > 0 && BestBin < Combined.length - 1) {
    const A = Combined[BestBin - 1];
    const B = Combined[BestBin];
    const C = Combined[BestBin + 1];
    const Denominator = A - 2 * B + C;
    if (Denominator < 0) Shift = clamp((0.5 * (A - C)) / Denominator, -0.5, 0.5);
  }
  const Rate = (FirstBin + BestBin + Shift) * (LowRate / FftSize) * 60;
  // How far the peak stands above a flat spectrum (1 = flat).
  const Peakiness = (Combined[BestBin] / Total) * Combined.length;
  // A clean sine scores about 9 here (the zero-padded peak spans many bins); flat noise about 1 to 2.
  return { Rate, Confidence: clamp((Peakiness - 2) / 5, 0, 1), Wave: BestWave, WaveRate: LowRate };
}
