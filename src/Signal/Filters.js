// Butterworth filters built from biquad sections, zero-phase filtering, and
// detrending.

/** @typedef {{ B0: number, B1: number, B2: number, A1: number, A2: number }} Biquad */

// Quality factors of the two biquads that make a 4th-order Butterworth.
const ButterworthQ4 = [1 / (2 * Math.cos(Math.PI / 8)), 1 / (2 * Math.cos((3 * Math.PI) / 8))];

/**
 * RBJ cookbook biquad.
 * @param {'lowpass' | 'highpass'} Kind
 * @param {number} Cutoff
 * @param {number} SampleRate
 * @param {number} Q
 * @returns {Biquad}
 */
export function biquad(Kind, Cutoff, SampleRate, Q) {
  const Omega = (2 * Math.PI * Cutoff) / SampleRate;
  const Cos = Math.cos(Omega);
  const Alpha = Math.sin(Omega) / (2 * Q);
  const A0 = 1 + Alpha;
  let B0;
  let B1;
  if (Kind === 'lowpass') {
    B1 = 1 - Cos;
    B0 = B1 / 2;
  } else {
    B1 = -(1 + Cos);
    B0 = (1 + Cos) / 2;
  }
  return { B0: B0 / A0, B1: B1 / A0, B2: B0 / A0, A1: (-2 * Cos) / A0, A2: (1 - Alpha) / A0 };
}

/**
 * 4th-order Butterworth high-pass followed by 4th-order low-pass.
 * @param {number} Low
 * @param {number} High
 * @param {number} SampleRate
 * @returns {Biquad[]}
 */
export function bandpass(Low, High, SampleRate) {
  return [
    ...ButterworthQ4.map((Q) => biquad('highpass', Low, SampleRate, Q)),
    ...ButterworthQ4.map((Q) => biquad('lowpass', High, SampleRate, Q)),
  ];
}

/**
 * Causal filtering through a cascade of sections (direct form II transposed).
 * @param {Biquad[]} Sections
 * @param {ArrayLike<number>} Input
 */
export function applySections(Sections, Input) {
  const Output = Float64Array.from(Input);
  for (const Section of Sections) {
    let Z1 = 0;
    let Z2 = 0;
    for (let Index = 0; Index < Output.length; Index++) {
      const X = Output[Index];
      const Y = Section.B0 * X + Z1;
      Z1 = Section.B1 * X - Section.A1 * Y + Z2;
      Z2 = Section.B2 * X - Section.A2 * Y;
      Output[Index] = Y;
    }
  }
  return Output;
}

/**
 * Zero-phase filtering: forward then backward, with odd reflection padding at
 * both ends so the filter does not ring at the edges.
 * @param {Biquad[]} Sections
 * @param {ArrayLike<number>} Input
 * @param {number} PadLength
 */
export function filtfilt(Sections, Input, PadLength) {
  const Length = Input.length;
  if (Length === 0) return new Float64Array(0);
  const Pad = Math.max(0, Math.min(Length - 1, Math.round(PadLength)));
  const Padded = new Float64Array(Length + 2 * Pad);
  const First = Input[0];
  const Last = Input[Length - 1];
  for (let Index = 0; Index < Pad; Index++) {
    Padded[Index] = 2 * First - Input[Pad - Index];
    Padded[Pad + Length + Index] = 2 * Last - Input[Length - 2 - Index];
  }
  for (let Index = 0; Index < Length; Index++) Padded[Pad + Index] = Input[Index];
  const Forward = applySections(Sections, Padded);
  Forward.reverse();
  const Backward = applySections(Sections, Forward);
  Backward.reverse();
  return Backward.slice(Pad, Pad + Length);
}

/**
 * Removes the least-squares straight line.
 * @param {ArrayLike<number>} Input
 */
export function detrend(Input) {
  const Length = Input.length;
  const Output = new Float64Array(Length);
  if (Length === 0) return Output;
  const MeanX = (Length - 1) / 2;
  let MeanY = 0;
  for (let Index = 0; Index < Length; Index++) MeanY += Input[Index];
  MeanY /= Length;
  let Covariance = 0;
  let Variance = 0;
  for (let Index = 0; Index < Length; Index++) {
    Covariance += (Index - MeanX) * (Input[Index] - MeanY);
    Variance += (Index - MeanX) * (Index - MeanX);
  }
  const Slope = Variance ? Covariance / Variance : 0;
  for (let Index = 0; Index < Length; Index++) Output[Index] = Input[Index] - MeanY - Slope * (Index - MeanX);
  return Output;
}

/**
 * Centered moving average; the window shrinks near the edges.
 * @param {ArrayLike<number>} Input
 * @param {number} Window Samples.
 */
export function movingAverage(Input, Window) {
  const Length = Input.length;
  const Output = new Float64Array(Length);
  const Half = Math.max(0, Math.floor(Window / 2));
  const Prefix = new Float64Array(Length + 1);
  for (let Index = 0; Index < Length; Index++) Prefix[Index + 1] = Prefix[Index] + Input[Index];
  for (let Index = 0; Index < Length; Index++) {
    const Start = Math.max(0, Index - Half);
    const End = Math.min(Length, Index + Half + 1);
    Output[Index] = (Prefix[End] - Prefix[Start]) / (End - Start);
  }
  return Output;
}

/**
 * Averages non-overlapping blocks, lowering the sample rate by Factor.
 * @param {ArrayLike<number>} Input
 * @param {number} Factor
 */
export function decimate(Input, Factor) {
  const Length = Math.floor(Input.length / Factor);
  const Output = new Float64Array(Length);
  for (let Block = 0; Block < Length; Block++) {
    let Sum = 0;
    for (let Offset = 0; Offset < Factor; Offset++) Sum += Input[Block * Factor + Offset];
    Output[Block] = Sum / Factor;
  }
  return Output;
}
