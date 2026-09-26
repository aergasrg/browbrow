import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fft } from '../src/Signal/Fft.js';
import { bandpass, filtfilt, applySections, detrend, movingAverage, decimate } from '../src/Signal/Filters.js';
import { Resampler } from '../src/Signal/Resampler.js';
import { estimateRate } from '../src/Signal/Spectrum.js';
import { createRandom, median, robustStd, std } from '../src/Signal/Stats.js';

const Rate = 30;

/** @param {number} Seconds @param {(Time: number) => number} Shape */
function sampled(Seconds, Shape) {
  return Float64Array.from({ length: Math.round(Seconds * Rate) }, (_, Index) => Shape(Index / Rate));
}

test('FFT matches a brute-force DFT and inverts exactly', () => {
  const Random = createRandom(1);
  const Size = 64;
  const Re = Float64Array.from({ length: Size }, () => Random.gaussian());
  const Im = Float64Array.from({ length: Size }, () => Random.gaussian());
  const OriginalRe = Re.slice();
  const OriginalIm = Im.slice();
  const Transform = new Fft(Size);
  Transform.transform(Re, Im);
  for (let K = 0; K < Size; K++) {
    let SumRe = 0;
    let SumIm = 0;
    for (let N = 0; N < Size; N++) {
      const Angle = (-2 * Math.PI * K * N) / Size;
      SumRe += OriginalRe[N] * Math.cos(Angle) - OriginalIm[N] * Math.sin(Angle);
      SumIm += OriginalRe[N] * Math.sin(Angle) + OriginalIm[N] * Math.cos(Angle);
    }
    assert.ok(Math.abs(SumRe - Re[K]) < 1e-9 && Math.abs(SumIm - Im[K]) < 1e-9, `bin ${K}`);
  }
  Transform.transform(Re, Im, true);
  for (let N = 0; N < Size; N++) assert.ok(Math.abs(Re[N] - OriginalRe[N]) < 1e-12 && Math.abs(Im[N] - OriginalIm[N]) < 1e-12);
  assert.throws(() => new Fft(48));
});

test('band-pass keeps heart-rate frequencies and rejects the rest', () => {
  const Sections = bandpass(0.7, 4, Rate);
  /** @param {number} Hz */
  const gain = (Hz) => {
    const Output = applySections(Sections, sampled(60, (Time) => Math.sin(2 * Math.PI * Hz * Time)));
    return std(Output.subarray(Output.length / 2)) / Math.SQRT1_2;
  };
  assert.ok(Math.abs(gain(1.5) - 1) < 0.05, `1.5 Hz gain ${gain(1.5)}`);
  assert.ok(gain(0.15) < 0.01, `0.15 Hz gain ${gain(0.15)}`);
  assert.ok(gain(10) < 0.05, `10 Hz gain ${gain(10)}`);
});

test('filtfilt is zero-phase: peaks stay where they were', () => {
  const Sections = bandpass(0.7, 4, Rate);
  const Input = sampled(20, (Time) => Math.cos(2 * Math.PI * 1.2 * Time));
  const Output = filtfilt(Sections, Input, 3 * Rate);
  // Compare a peak in the middle of the signal.
  const Middle = Math.round((10 / 1.2) * 1.2) / 1.2; // 10 s is not a peak; use nearest multiple of the period.
  const PeakIndex = Math.round(Math.round(Middle * 1.2) / 1.2 * Rate);
  let Best = PeakIndex - 5;
  for (let Index = PeakIndex - 5; Index <= PeakIndex + 5; Index++) if (Output[Index] > Output[Best]) Best = Index;
  assert.ok(Math.abs(Best - PeakIndex) <= 1, `peak moved from ${PeakIndex} to ${Best}`);
});

test('detrend, movingAverage, decimate, and robust stats', () => {
  const Line = Float64Array.from({ length: 50 }, (_, Index) => 3 + 0.5 * Index);
  assert.ok(Math.max(...detrend(Line).map(Math.abs)) < 1e-9);
  assert.deepEqual(Array.from(movingAverage([1, 2, 3, 4, 5], 3)), [1.5, 2, 3, 4, 4.5]);
  assert.deepEqual(Array.from(decimate([1, 3, 5, 7, 9, 11, 13], 2)), [2, 6, 10]);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  const WithSpike = Float64Array.from({ length: 200 }, (_, Index) => (Index % 2 ? 1 : -1));
  WithSpike[50] = 1000;
  assert.ok(robustStd(WithSpike) < 2, 'one spike should not blow up the robust spread');
});

test('resampler produces evenly spaced samples from jittery frames', () => {
  const Resample = new Resampler(Rate, 1);
  const Random = createRandom(3);
  /** @type {{ Time: number, Values: Float64Array }[]} */
  const Output = [];
  let Time = 0;
  while (Time < 5) {
    const { Samples } = Resample.push(Time, [Math.sin(2 * Math.PI * Time), Time]);
    Output.push(...Samples);
    Time += 1 / 24 + (Random.next() - 0.5) * 0.02; // About 24 fps with jitter.
  }
  for (let Index = 1; Index < Output.length; Index++) {
    assert.ok(Math.abs(Output[Index].Time - Output[Index - 1].Time - 1 / Rate) < 1e-9);
  }
  for (const Sample of Output) {
    assert.ok(Math.abs(Sample.Values[1] - Sample.Time) < 1e-9, 'linear channel is reproduced exactly');
    assert.ok(Math.abs(Sample.Values[0] - Math.sin(2 * Math.PI * Sample.Time)) < 0.02);
  }
  const AfterGap = Resample.push(Time + 3, [0, 0]);
  assert.equal(AfterGap.Restarted, true);
  assert.equal(AfterGap.Samples.length, 1);
});

test('rate estimator finds the peak with sub-bin accuracy and scores SNR', () => {
  const Random = createRandom(4);
  const Clean = sampled(10, (Time) => Math.sin(2 * Math.PI * (73.4 / 60) * Time) + 0.2 * Random.gaussian());
  const Result = estimateRate(Clean, Rate, { MinBpm: 42, MaxBpm: 240 });
  assert.ok(Math.abs(Result.Bpm - 73.4) < 0.5, `got ${Result.Bpm}`);
  assert.ok(Result.Snr > 6, `clean SNR ${Result.Snr}`);
  assert.equal(Result.Confidence, 1);
  const Noise = sampled(10, () => Random.gaussian());
  const NoiseResult = estimateRate(bandpassed(Noise), Rate, { MinBpm: 42, MaxBpm: 240 });
  assert.ok(NoiseResult.Snr < 0, `noise SNR ${NoiseResult.Snr}`);
  assert.ok(NoiseResult.Confidence < 0.4);
});

test('rate estimator prefers continuity when two peaks are close in power', () => {
  const Mixed = sampled(10, (Time) => Math.sin(2 * Math.PI * (70 / 60) * Time) + 0.9 * Math.sin(2 * Math.PI * (130 / 60) * Time));
  assert.ok(Math.abs(estimateRate(Mixed, Rate, { MinBpm: 42, MaxBpm: 240 }).Bpm - 70) < 1);
  assert.ok(Math.abs(estimateRate(Mixed, Rate, { MinBpm: 42, MaxBpm: 240, PreviousBpm: 128 }).Bpm - 130) < 1);
});

/** @param {Float64Array} Signal */
function bandpassed(Signal) {
  return filtfilt(bandpass(0.7, 4, Rate), Signal, 90);
}
