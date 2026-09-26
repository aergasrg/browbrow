// Finds the dominant rhythm in a signal and scores how clearly it stands out.

import { getFft, nextPowerOfTwo } from './Fft.js';
import { clamp } from './Stats.js';

/**
 * @typedef {object} RateEstimate
 * @property {number} Bpm Dominant rate in cycles per minute (sub-bin interpolated).
 * @property {number} Snr Power near the peak and its harmonic versus the rest of the band, in dB.
 * @property {number} Confidence 0..1 mapping of Snr.
 * @property {Float32Array} Bpms Frequency axis of the in-band spectrum, per minute.
 * @property {Float32Array} Power In-band power normalized to a peak of 1.
 */

/**
 * @param {ArrayLike<number>} Signal Evenly sampled, already band-passed.
 * @param {number} SampleRate
 * @param {object} Options
 * @param {number} Options.MinBpm
 * @param {number} Options.MaxBpm
 * @param {number | null} [Options.PreviousBpm] Soft preference for continuity with the last estimate.
 * @param {number} [Options.PadTo] Minimum FFT size (zero padding gives finer bins to interpolate).
 * @param {number} [Options.PeakToleranceHz] Half-width counted as "signal" around the peak.
 * @param {boolean} [Options.CountHarmonic] Count the second harmonic as signal.
 * @param {[number, number]} [Options.ConfidenceRangeDb] Snr mapped to confidence 0 and 1.
 * @returns {RateEstimate}
 */
export function estimateRate(Signal, SampleRate, Options) {
  const {
    MinBpm,
    MaxBpm,
    PreviousBpm = null,
    PadTo = 2048,
    PeakToleranceHz = 0.15,
    CountHarmonic = true,
    ConfidenceRangeDb = [-3, 6],
  } = Options;
  const Length = Signal.length;
  const Size = Math.max(PadTo, nextPowerOfTwo(Length));
  const Re = new Float64Array(Size);
  const Im = new Float64Array(Size);
  let Mean = 0;
  for (let Index = 0; Index < Length; Index++) Mean += Signal[Index];
  Mean /= Length || 1;
  for (let Index = 0; Index < Length; Index++) {
    const Hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * Index) / Math.max(1, Length - 1));
    Re[Index] = (Signal[Index] - Mean) * Hann;
  }
  getFft(Size).transform(Re, Im);

  const BinHz = SampleRate / Size;
  const FirstBin = Math.max(1, Math.ceil(MinBpm / 60 / BinHz));
  const LastBin = Math.min(Size / 2 - 1, Math.floor(MaxBpm / 60 / BinHz));
  const BinCount = Math.max(0, LastBin - FirstBin + 1);
  const Power = new Float64Array(BinCount);
  for (let Bin = 0; Bin < BinCount; Bin++) {
    const K = FirstBin + Bin;
    Power[Bin] = Re[K] * Re[K] + Im[K] * Im[K];
  }

  // Pick the strongest local peak, gently favoring continuity: a peak far from
  // the previous estimate needs up to twice the power to win.
  let BestBin = -1;
  let BestScore = -Infinity;
  for (let Bin = 0; Bin < BinCount; Bin++) {
    const Left = Bin > 0 ? Power[Bin - 1] : -Infinity;
    const Right = Bin < BinCount - 1 ? Power[Bin + 1] : -Infinity;
    if (Power[Bin] < Left || Power[Bin] < Right) continue;
    let Score = Power[Bin];
    if (PreviousBpm !== null && PreviousBpm !== undefined) {
      const Distance = (FirstBin + Bin) * BinHz * 60 - PreviousBpm;
      Score *= 0.5 + 0.5 * Math.exp(-(Distance * Distance) / (2 * 15 * 15));
    }
    if (Score > BestScore) {
      BestScore = Score;
      BestBin = Bin;
    }
  }

  const Bpms = new Float32Array(BinCount);
  const Normalized = new Float32Array(BinCount);
  let MaxPower = 0;
  for (let Bin = 0; Bin < BinCount; Bin++) MaxPower = Math.max(MaxPower, Power[Bin]);
  for (let Bin = 0; Bin < BinCount; Bin++) {
    Bpms[Bin] = (FirstBin + Bin) * BinHz * 60;
    Normalized[Bin] = MaxPower > 0 ? Power[Bin] / MaxPower : 0;
  }
  if (BestBin < 0 || MaxPower <= 0) {
    return { Bpm: 0, Snr: -Infinity, Confidence: 0, Bpms, Power: Normalized };
  }

  // Parabolic interpolation on log power around the peak.
  let Shift = 0;
  if (BestBin > 0 && BestBin < BinCount - 1) {
    const A = Math.log(Power[BestBin - 1] + 1e-30);
    const B = Math.log(Power[BestBin] + 1e-30);
    const C = Math.log(Power[BestBin + 1] + 1e-30);
    const Denominator = A - 2 * B + C;
    if (Denominator < 0) Shift = clamp((0.5 * (A - C)) / Denominator, -0.5, 0.5);
  }
  const PeakHz = (FirstBin + BestBin + Shift) * BinHz;

  let SignalPower = 0;
  let NoisePower = 0;
  for (let Bin = 0; Bin < BinCount; Bin++) {
    const Hz = (FirstBin + Bin) * BinHz;
    const NearPeak = Math.abs(Hz - PeakHz) <= PeakToleranceHz;
    const NearHarmonic = CountHarmonic && Math.abs(Hz - 2 * PeakHz) <= PeakToleranceHz * 1.5;
    if (NearPeak || NearHarmonic) SignalPower += Power[Bin];
    else NoisePower += Power[Bin];
  }
  const Snr = 10 * Math.log10((SignalPower + 1e-30) / (NoisePower + 1e-30));
  const [ZeroDb, FullDb] = ConfidenceRangeDb;
  return {
    Bpm: PeakHz * 60,
    Snr,
    Confidence: clamp((Snr - ZeroDb) / (FullDb - ZeroDb), 0, 1),
    Bpms,
    Power: Normalized,
  };
}
