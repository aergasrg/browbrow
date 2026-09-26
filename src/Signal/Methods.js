// Pulse extraction: turn the average skin color over time into a pulse signal.
//
// All three methods return a signal whose peaks line up with the moment of
// maximum blood volume (systole), so beat markers and the heart animation
// line up no matter which method is selected. The engine band-pass filters
// the result afterwards.

import { PulseWindowSeconds } from '../Config.js';
import { mean, std } from './Stats.js';
import { bandpass, filtfilt, movingAverage } from './Filters.js';

/** @typedef {(R: Float64Array, G: Float64Array, B: Float64Array, SampleRate: number) => Float64Array} PulseExtractor */

/**
 * Sliding-window overlap-add. For each window, Project receives the window's
 * start and length and writes its contribution into Scratch; contributions are
 * mean-removed, summed, and divided by how many windows covered each sample.
 * @param {number} Length
 * @param {number} Window
 * @param {(Start: number, Size: number, Scratch: Float64Array) => boolean} Project
 */
function overlapAdd(Length, Window, Project) {
  const Output = new Float64Array(Length);
  const Coverage = new Uint16Array(Length);
  const Size = Math.min(Window, Length);
  const Scratch = new Float64Array(Size);
  if (Size < 2) return Output;
  for (let Start = 0; Start + Size <= Length; Start++) {
    if (!Project(Start, Size, Scratch)) continue;
    const Mean = mean(Scratch);
    for (let Offset = 0; Offset < Size; Offset++) {
      Output[Start + Offset] += Scratch[Offset] - Mean;
      Coverage[Start + Offset]++;
    }
  }
  for (let Index = 0; Index < Length; Index++) if (Coverage[Index]) Output[Index] /= Coverage[Index];
  return Output;
}

/**
 * Plane-Orthogonal-to-Skin (Wang, den Brinker, Stuijk & de Haan, 2017).
 * Normalizes each channel by its local mean, projects onto two axes that are
 * orthogonal to the skin tone, and mixes them so specular and brightness
 * changes cancel.
 * @type {PulseExtractor}
 */
export function pos(R, G, B, SampleRate) {
  const Window = Math.round(PulseWindowSeconds * SampleRate);
  const S1 = new Float64Array(Math.min(Window, R.length));
  const S2 = new Float64Array(Math.min(Window, R.length));
  const Output = overlapAdd(R.length, Window, (Start, Size, Scratch) => {
    let MeanR = 0;
    let MeanG = 0;
    let MeanB = 0;
    for (let Offset = 0; Offset < Size; Offset++) {
      MeanR += R[Start + Offset];
      MeanG += G[Start + Offset];
      MeanB += B[Start + Offset];
    }
    MeanR /= Size;
    MeanG /= Size;
    MeanB /= Size;
    if (MeanR <= 0 || MeanG <= 0 || MeanB <= 0) return false;
    for (let Offset = 0; Offset < Size; Offset++) {
      const Rn = R[Start + Offset] / MeanR;
      const Gn = G[Start + Offset] / MeanG;
      const Bn = B[Start + Offset] / MeanB;
      S1[Offset] = Gn - Bn;
      S2[Offset] = -2 * Rn + Gn + Bn;
    }
    const Spread2 = std(S2);
    const Alpha = Spread2 > 1e-12 ? std(S1) / Spread2 : 0;
    for (let Offset = 0; Offset < Size; Offset++) Scratch[Offset] = S1[Offset] + Alpha * S2[Offset];
    return true;
  });
  // Blood absorbs light, so the projection dips at systole; flip it so beats are peaks.
  for (let Index = 0; Index < Output.length; Index++) Output[Index] = -Output[Index];
  return Output;
}

/**
 * Chrominance-based method (de Haan & Jeanne, 2013). Builds two chrominance
 * signals, band-passes them, and subtracts them with a ratio that cancels
 * motion-induced brightness changes.
 * @type {PulseExtractor}
 */
export function chrom(R, G, B, SampleRate) {
  const Window = Math.round(PulseWindowSeconds * SampleRate);
  const Length = R.length;
  const BaseR = movingAverage(R, Window);
  const BaseG = movingAverage(G, Window);
  const BaseB = movingAverage(B, Window);
  const X = new Float64Array(Length);
  const Y = new Float64Array(Length);
  for (let Index = 0; Index < Length; Index++) {
    const Rn = BaseR[Index] > 0 ? R[Index] / BaseR[Index] : 1;
    const Gn = BaseG[Index] > 0 ? G[Index] / BaseG[Index] : 1;
    const Bn = BaseB[Index] > 0 ? B[Index] / BaseB[Index] : 1;
    X[Index] = 3 * Rn - 2 * Gn;
    Y[Index] = 1.5 * Rn + Gn - 1.5 * Bn;
  }
  const Sections = bandpass(0.7, 4, SampleRate);
  const Xf = filtfilt(Sections, X, 3 * SampleRate);
  const Yf = filtfilt(Sections, Y, 3 * SampleRate);
  return overlapAdd(Length, Window, (Start, Size, Scratch) => {
    const WindowX = Xf.subarray(Start, Start + Size);
    const WindowY = Yf.subarray(Start, Start + Size);
    const SpreadY = std(WindowY);
    const Alpha = SpreadY > 1e-12 ? std(WindowX) / SpreadY : 0;
    for (let Offset = 0; Offset < Size; Offset++) Scratch[Offset] = WindowX[Offset] - Alpha * WindowY[Offset];
    return true;
  });
}

/**
 * The original remote PPG signal (Verkruysse, Svaasand & Nelson, 2008): the
 * green channel, where hemoglobin absorbs most. Simple, and the easiest to
 * fool with motion or lighting changes.
 * @type {PulseExtractor}
 */
export function green(_R, G, _B, SampleRate) {
  const Base = movingAverage(G, Math.round(PulseWindowSeconds * SampleRate));
  const Output = new Float64Array(G.length);
  for (let Index = 0; Index < G.length; Index++) Output[Index] = Base[Index] > 0 ? 1 - G[Index] / Base[Index] : 0;
  return Output;
}

/** @typedef {'POS' | 'CHROM' | 'Green'} MethodName */

/** @type {Record<MethodName, { Name: MethodName, Label: string, Year: number, Summary: string, extract: PulseExtractor }>} */
export const Methods = {
  POS: {
    Name: 'POS',
    Label: 'POS',
    Year: 2017,
    Summary: 'Projects color onto a plane orthogonal to skin tone. Robust to lighting and skin tone.',
    extract: pos,
  },
  CHROM: {
    Name: 'CHROM',
    Label: 'CHROM',
    Year: 2013,
    Summary: 'Mixes two chrominance signals to cancel motion-induced brightness changes.',
    extract: chrom,
  },
  Green: {
    Name: 'Green',
    Label: 'Green',
    Year: 2008,
    Summary: 'Green channel only, where blood absorbs most. Simple but easily fooled.',
    extract: green,
  },
};

/** @type {MethodName[]} */
export const MethodNames = ['POS', 'CHROM', 'Green'];
