// A simulated face: produces the average skin color of each region at any
// moment, with a known heart rate. Drives demo mode and the tests.
//
// Model per region and channel c:
//   I_c(t) = Base_c * Light(t) * (1 - Amplitude * BloodVolumePulse_c * Pulse(t) - Breath(t))
//            + Specular(t) + Noise_c(t)
// Pulse(t) is a PPG-shaped wave (systolic peak plus dicrotic bump) whose
// phase follows the heart rate, which drifts slowly and speeds up on each
// inhale (respiratory sinus arrhythmia).

import { BloodVolumePulse } from '../Config.js';
import { createRandom } from '../Signal/Stats.js';

/** @typedef {import('../Vision/Regions.js').RegionName} RegionName */
/** @typedef {import('../Vision/Regions.js').Observation} Observation */

/**
 * @typedef {object} SubjectOptions
 * @property {number} [Seed]
 * @property {number} [BaseBpm] Resting heart rate.
 * @property {number} [DriftBpm] Amplitude of the slow heart-rate drift.
 * @property {number} [DriftPeriod] Seconds per drift cycle.
 * @property {number} [BreathsPerMinute]
 * @property {number} [RsaBpm] Heart-rate swing with each breath.
 * @property {number} [PulseAmplitude] Relative skin color change per beat (about 0.2 to 0.5 percent on real skin).
 * @property {number} [NoiseLevel] Relative in-band noise; 0.001 is a good camera in good light.
 * @property {number} [LightDrift] Relative slow illumination drift.
 * @property {number} [MotionEvery] Seconds between motion bursts, 0 for none.
 * @property {[number, number, number]} [SkinTone] Average skin color, 0..255.
 */

const RegionShares = /** @type {Record<RegionName, { Brightness: number, Pixels: number, Strength: number }>} */ ({
  Forehead: { Brightness: 1.06, Pixels: 5200, Strength: 1.0 },
  LeftCheek: { Brightness: 1.0, Pixels: 3600, Strength: 0.85 },
  RightCheek: { Brightness: 0.97, Pixels: 3600, Strength: 0.85 },
});

export class SyntheticSubject {
  /** @param {SubjectOptions} [Options] */
  constructor(Options = {}) {
    this.Seed = Options.Seed ?? 7;
    this.BaseBpm = Options.BaseBpm ?? 72;
    this.DriftBpm = Options.DriftBpm ?? 4;
    this.DriftPeriod = Options.DriftPeriod ?? 75;
    this.BreathsPerMinute = Options.BreathsPerMinute ?? 14;
    this.RsaBpm = Options.RsaBpm ?? 2.5;
    this.PulseAmplitude = Options.PulseAmplitude ?? 0.004;
    this.NoiseLevel = Options.NoiseLevel ?? 0.0008;
    this.LightDrift = Options.LightDrift ?? 0.02;
    this.MotionEvery = Options.MotionEvery ?? 0;
    this.SkinTone = Options.SkinTone ?? [178, 128, 104];
    this.Random = createRandom(this.Seed);
    /** @type {Record<string, number>} */
    this.NoiseState = {};
  }

  /** Instantaneous heart rate. @param {number} Time */
  heartRateAt(Time) {
    const BreathHz = this.BreathsPerMinute / 60;
    return (
      this.BaseBpm +
      this.DriftBpm * Math.sin((2 * Math.PI * Time) / this.DriftPeriod) +
      this.RsaBpm * Math.sin(2 * Math.PI * BreathHz * Time)
    );
  }

  /** Beat phase in cycles: the integral of heart rate over time. @param {number} Time */
  beatPhaseAt(Time) {
    const BreathHz = this.BreathsPerMinute / 60;
    const DriftTerm = ((this.DriftBpm * this.DriftPeriod) / (2 * Math.PI)) * (1 - Math.cos((2 * Math.PI * Time) / this.DriftPeriod));
    const RsaTerm = BreathHz > 0 ? (this.RsaBpm / (2 * Math.PI * BreathHz)) * (1 - Math.cos(2 * Math.PI * BreathHz * Time)) : 0;
    return (this.BaseBpm * Time + DriftTerm + RsaTerm) / 60;
  }

  /** Times of systolic peaks between two moments (for checking beat detection). @param {number} From @param {number} To */
  beatTimesBetween(From, To) {
    /** @type {number[]} */
    const Times = [];
    const Step = 0.002;
    let Previous = this.pulseAt(From - Step);
    let Current = this.pulseAt(From);
    for (let Time = From; Time <= To; Time += Step) {
      const Next = this.pulseAt(Time + Step);
      if (Current > Previous && Current >= Next && Current > 0.5) Times.push(Time);
      Previous = Current;
      Current = Next;
    }
    return Times;
  }

  /** PPG-shaped pulse, peak 1 at systole. @param {number} Time */
  pulseAt(Time) {
    const Phase = this.beatPhaseAt(Time) % 1;
    const Systolic = Math.exp(-(((Phase - 0.25) / 0.09) ** 2));
    const Dicrotic = 0.35 * Math.exp(-(((Phase - 0.55) / 0.11) ** 2));
    return Systolic + Dicrotic;
  }

  /** Relative head bob and brightness change from breathing, -1..1. @param {number} Time */
  breathAt(Time) {
    return Math.sin(2 * Math.PI * (this.BreathsPerMinute / 60) * Time);
  }

  /** 0..1 strength of the motion burst active at Time. @param {number} Time */
  motionAt(Time) {
    if (!this.MotionEvery) return 0;
    const Offset = Time % this.MotionEvery;
    const Start = this.MotionEvery * 0.6;
    if (Offset < Start || Offset > Start + 1.5) return 0;
    return Math.sin((Math.PI * (Offset - Start)) / 1.5);
  }

  /**
   * Smoothly varying noise: first-order autoregressive, so it has most of its
   * power at low frequencies like real camera and lighting noise.
   * @param {string} Key
   */
  colored(Key) {
    const Previous = this.NoiseState[Key] ?? 0;
    const Next = 0.85 * Previous + Math.sqrt(1 - 0.85 * 0.85) * this.Random.gaussian();
    this.NoiseState[Key] = Next;
    return Next;
  }

  /**
   * Average skin color of each region at Time, plus face position.
   * @param {number} Time
   * @returns {Observation}
   */
  observe(Time) {
    const Pulse = this.pulseAt(Time) - 0.35;
    const Breath = this.breathAt(Time);
    const Motion = this.motionAt(Time);
    const Light = 1 + this.LightDrift * Math.sin((2 * Math.PI * Time) / 41) + 0.004 * Math.sin((2 * Math.PI * Time) / 9.7);
    // Motion: the face tilts, so brightness and specular highlights swing at about 1.3 Hz (inside the heart band).
    const Swing = Motion * Math.sin(2 * Math.PI * 1.3 * Time);
    /** @type {Partial<Observation['Regions']>} */
    const Regions = {};
    for (const [Name, Share] of Object.entries(RegionShares)) {
      const Shading = 1 + 0.02 * Swing * Share.Brightness;
      const Specular = 6 * Math.max(0, Swing) * Share.Brightness;
      /** @type {number[]} */
      const Channels = [];
      for (let Channel = 0; Channel < 3; Channel++) {
        const Base = this.SkinTone[Channel] * Share.Brightness;
        const Absorb = this.PulseAmplitude * Share.Strength * BloodVolumePulse[Channel] * Pulse + 0.0008 * Breath;
        // Real camera noise is mostly shared brightness flicker (lighting, auto exposure,
        // micro-motion) that hits all channels together; per-channel sensor noise averages
        // away over thousands of pixels.
        const Noise =
          this.NoiseLevel * Base * (this.colored(`Shared${Name}`) + 0.15 * this.Random.gaussian()) +
          0.15 * this.NoiseLevel * Base * this.colored(`${Name}${Channel}`);
        Channels.push(Base * Light * Shading * (1 - Absorb) + Specular + Noise);
      }
      Regions[/** @type {RegionName} */ (Name)] = { R: Channels[0], G: Channels[1], B: Channels[2], Count: Share.Pixels };
    }
    return {
      Regions: /** @type {Observation['Regions']} */ (Regions),
      FaceX: 0.5 + 0.01 * Swing,
      FaceY: 0.45 + 0.0025 * Breath + 0.01 * Swing,
      FaceWidth: 0.42,
      FaceHeight: 0.55,
      Luma: 0.299 * this.SkinTone[0] + 0.587 * this.SkinTone[1] + 0.114 * this.SkinTone[2],
      ClippedFraction: 0,
    };
  }
}
