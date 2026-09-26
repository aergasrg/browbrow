// Live checks that tell the user what to fix: lighting, motion, distance.

import { clamp } from '../Signal/Stats.js';

/** @typedef {import('./Regions.js').Observation} Observation */
/** @typedef {'good' | 'warn' | 'bad'} Level */
/** @typedef {{ Level: Level, Label: string, Hint: string }} Check */

/**
 * @typedef {object} SceneState
 * @property {boolean} Face
 * @property {Check} Lighting
 * @property {Check} Motion
 * @property {Check} Distance
 * @property {number} Fps Frames analyzed per second.
 * @property {number} Luma
 * @property {number} MotionSpeed Face widths per second.
 */

export class SceneChecks {
  constructor() {
    /** @type {{ X: number, Y: number, Time: number } | null} */
    this.LastCenter = null;
    this.Speed = 0;
    this.Luma = 0;
    this.Clipped = 0;
    this.FaceWidth = 0;
    this.FaceSeenAt = -Infinity;
    /** @type {number[]} */
    this.FrameTimes = [];
  }

  reset() {
    this.LastCenter = null;
    this.Speed = 0;
    this.Luma = 0;
    this.Clipped = 0;
    this.FaceWidth = 0;
    this.FaceSeenAt = -Infinity;
    this.FrameTimes = [];
  }

  /**
   * @param {number} Time Seconds.
   * @param {Observation | null} Observation Null when no face was found.
   * @returns {SceneState}
   */
  update(Time, Observation) {
    this.FrameTimes.push(Time);
    while (this.FrameTimes.length && this.FrameTimes[0] < Time - 2) this.FrameTimes.shift();
    if (Observation) {
      this.FaceSeenAt = Time;
      const Smoothing = 0.15;
      this.Luma = this.Luma ? this.Luma + Smoothing * (Observation.Luma - this.Luma) : Observation.Luma;
      this.Clipped += Smoothing * (Observation.ClippedFraction - this.Clipped);
      this.FaceWidth = this.FaceWidth ? this.FaceWidth + Smoothing * (Observation.FaceWidth - this.FaceWidth) : Observation.FaceWidth;
      if (this.LastCenter && Time > this.LastCenter.Time) {
        const Moved = Math.hypot(Observation.FaceX - this.LastCenter.X, Observation.FaceY - this.LastCenter.Y);
        const Instant = Moved / Math.max(0.05, Observation.FaceWidth) / (Time - this.LastCenter.Time);
        const Weight = clamp((Time - this.LastCenter.Time) / 0.4, 0, 1);
        this.Speed += Weight * (Instant - this.Speed);
      }
      this.LastCenter = { X: Observation.FaceX, Y: Observation.FaceY, Time };
    }
    return this.state(Time);
  }

  /** @param {number} Time @returns {SceneState} */
  state(Time) {
    const Face = Time - this.FaceSeenAt < 0.6;
    const Span = this.FrameTimes.length > 1 ? this.FrameTimes[this.FrameTimes.length - 1] - this.FrameTimes[0] : 0;
    const Fps = Span > 0 ? (this.FrameTimes.length - 1) / Span : 0;
    return {
      Face,
      Lighting: Face ? this.lighting() : { Level: /** @type {Level} */ ('warn'), Label: 'Light', Hint: 'Waiting for a face' },
      Motion: Face ? this.motion() : { Level: /** @type {Level} */ ('warn'), Label: 'Motion', Hint: 'Waiting for a face' },
      Distance: Face ? this.distance() : { Level: /** @type {Level} */ ('warn'), Label: 'Distance', Hint: 'Waiting for a face' },
      Fps,
      Luma: this.Luma,
      MotionSpeed: this.Speed,
    };
  }

  /** @returns {Check} */
  lighting() {
    if (this.Clipped > 0.25) return { Level: 'bad', Label: 'Too bright', Hint: 'Glare is washing out your skin. Turn slightly away from the light.' };
    if (this.Luma < 45) return { Level: 'bad', Label: 'Too dark', Hint: 'Face a window or lamp, or turn on Screen Light.' };
    if (this.Luma < 75) return { Level: 'warn', Label: 'Dim', Hint: 'More light on your face will steady the reading.' };
    if (this.Luma > 215) return { Level: 'warn', Label: 'Very bright', Hint: 'Slightly less light avoids blown-out skin.' };
    return { Level: 'good', Label: 'Good light', Hint: 'Lighting looks good.' };
  }

  /** @returns {Check} */
  motion() {
    if (this.Speed > 0.35) return { Level: 'bad', Label: 'Moving', Hint: 'Hold still. Movement drowns out the pulse.' };
    if (this.Speed > 0.12) return { Level: 'warn', Label: 'Slight motion', Hint: 'Try to keep your head still.' };
    return { Level: 'good', Label: 'Still', Hint: 'Nice and steady.' };
  }

  /** @returns {Check} */
  distance() {
    if (this.FaceWidth < 0.16) return { Level: 'bad', Label: 'Too far', Hint: 'Move closer so your face fills more of the frame.' };
    if (this.FaceWidth < 0.24) return { Level: 'warn', Label: 'A bit far', Hint: 'Moving a little closer gives more skin to read.' };
    if (this.FaceWidth > 0.8) return { Level: 'warn', Label: 'Too close', Hint: 'Move back so your whole face is visible.' };
    return { Level: 'good', Label: 'Good distance', Hint: 'Distance looks good.' };
  }
}
