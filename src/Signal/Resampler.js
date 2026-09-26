// Turns irregular camera-frame samples into an evenly spaced stream by linear
// interpolation. Camera frame rates wobble (and drop frames), but the filters
// and FFT need a constant sample rate.

/** @typedef {{ Time: number, Values: Float64Array }} UniformSample */

export class Resampler {
  /**
   * @param {number} Rate Output samples per second.
   * @param {number} MaxGapSeconds A larger gap between inputs restarts the stream.
   */
  constructor(Rate, MaxGapSeconds) {
    this.Rate = Rate;
    this.MaxGapSeconds = MaxGapSeconds;
    /** @type {number | null} */
    this.LastTime = null;
    /** @type {Float64Array | null} */
    this.LastValues = null;
    this.NextTime = 0;
  }

  reset() {
    this.LastTime = null;
    this.LastValues = null;
    this.NextTime = 0;
  }

  /**
   * @param {number} Time Seconds.
   * @param {ArrayLike<number>} Values
   * @returns {{ Restarted: boolean, Samples: UniformSample[] }}
   */
  push(Time, Values) {
    const Current = Float64Array.from(Values);
    /** @type {UniformSample[]} */
    const Samples = [];
    let Restarted = false;
    if (this.LastTime === null || this.LastValues === null || Time - this.LastTime > this.MaxGapSeconds) {
      Restarted = this.LastTime !== null;
      this.LastTime = Time;
      this.LastValues = Current;
      this.NextTime = Time;
    } else if (Time <= this.LastTime) {
      return { Restarted, Samples }; // Duplicate or out-of-order frame.
    }
    const Step = 1 / this.Rate;
    const LastTime = this.LastTime;
    const LastValues = this.LastValues;
    const Span = Time - LastTime;
    while (this.NextTime <= Time + 1e-9) {
      const Fraction = Span > 0 ? (this.NextTime - LastTime) / Span : 1;
      const Interpolated = new Float64Array(Current.length);
      for (let Channel = 0; Channel < Current.length; Channel++) {
        Interpolated[Channel] = LastValues[Channel] + Fraction * (Current[Channel] - LastValues[Channel]);
      }
      Samples.push({ Time: this.NextTime, Values: Interpolated });
      this.NextTime += Step;
    }
    this.LastTime = Time;
    this.LastValues = Current;
    return { Restarted, Samples };
  }
}
