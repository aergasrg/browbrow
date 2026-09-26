// The measurement engine. Takes one Observation per camera frame and keeps
// everything the UI shows: heart rate from all three methods, the live pulse
// waveform, beats, per-region signal quality, breathing, HRV, and the session
// log used for the trend chart, summary, and CSV export.

import {
  CalibrationSeconds,
  DefaultWindowSeconds,
  EstimateIntervalSeconds,
  HrvMinBeats,
  HrvWindowSeconds,
  MaxBpm,
  MaxGapSeconds,
  MaxSessionSeconds,
  MinBpm,
  RespirationMinSeconds,
  RespirationWindowSeconds,
  SampleRate,
  SlowEstimateIntervalSeconds,
  TraceHistorySeconds,
  WaveSeconds,
} from '../Config.js';
import { BeatTracker, computeHrv } from './Beats.js';
import { bandpass, filtfilt } from './Filters.js';
import { MethodNames, Methods } from './Methods.js';
import { Resampler } from './Resampler.js';
import { estimateRespiration } from './Respiration.js';
import { estimateRate } from './Spectrum.js';
import { clamp, mean, robustStd } from './Stats.js';

/** @typedef {import('./Methods.js').MethodName} MethodName */
/** @typedef {import('../Vision/Regions.js').RegionName} RegionName */
/** @typedef {import('../Vision/Regions.js').Observation} Observation */
/** @typedef {import('./Spectrum.js').RateEstimate} RateEstimate */
/** @typedef {import('./Beats.js').HrvResult} HrvResult */
/** @typedef {import('./Respiration.js').RespirationResult} RespirationResult */

/** @type {RegionName[]} */
const RegionList = ['Forehead', 'LeftCheek', 'RightCheek'];
const TraceNames = ['Combined', ...RegionList];
// Channel layout of each resampled sample.
const ChannelCount = TraceNames.length * 3 + 1;
const FaceYChannel = ChannelCount - 1;
const PadSeconds = 2;

/**
 * @typedef {object} MethodResult
 * @property {number} Bpm
 * @property {number} Snr
 * @property {number} Confidence
 * @property {Float32Array} Bpms
 * @property {Float32Array} Power
 */

/**
 * @typedef {object} EngineSnapshot
 * @property {'Searching' | 'Calibrating' | 'Measuring'} Phase
 * @property {number} CalibrationProgress 0..1 until the first reading.
 * @property {number} SecondsCollected Seconds of continuous signal.
 * @property {number} SessionSeconds Seconds since the first sample of the session.
 * @property {number | null} Bpm Smoothed heart rate for display.
 * @property {number | null} RawBpm Latest unsmoothed estimate from the selected method.
 * @property {number} Snr Selected method's signal-to-noise ratio, dB.
 * @property {number} Confidence 0..1.
 * @property {MethodName} Method
 * @property {Record<MethodName, MethodResult | null>} MethodResults
 * @property {number} Agreement 0..1, how closely the three methods agree.
 * @property {Record<RegionName, { Snr: number, Confidence: number, Pixels: number } | null>} RegionQuality
 * @property {{ Values: Float32Array, StartTime: number, Rate: number } | null} Wave Normalized pulse waveform.
 * @property {{ R: Float32Array, G: Float32Array, B: Float32Array, StartTime: number, Rate: number } | null} RawWave Filtered color change in percent.
 * @property {number} LatestPulse Newest waveform value (about -2..2).
 * @property {number[]} Beats Beat times within the waveform span.
 * @property {number[]} NewBeats Beats confirmed during this update.
 * @property {number} BeatCount Beats confirmed this session.
 * @property {HrvResult | null} Hrv
 * @property {number} HrvProgress 0..1 until enough beats for HRV.
 * @property {RespirationResult | null} Respiration
 * @property {number} RespirationProgress 0..1 until enough data for breathing.
 * @property {{ Min: number, Max: number, Average: number } | null} SessionStats
 * @property {'steady' | 'rising' | 'falling' | null} Trend
 * @property {{ R: number, G: number, B: number, Pixels: number } | null} LatestColor
 * @property {number} Now Time of this snapshot, seconds.
 * @property {number} SessionStart Time of the session's first sample.
 */

/**
 * @typedef {object} EstimateLogEntry
 * @property {number} Time
 * @property {number | null} Bpm
 * @property {number} RawBpm
 * @property {number} Snr
 * @property {number} Confidence
 * @property {Record<MethodName, number | null>} MethodBpms
 */

export class PulseEngine {
  /** @param {{ Method?: MethodName, WindowSeconds?: number }} [Options] */
  constructor(Options = {}) {
    /** @type {MethodName} */
    this.Method = Options.Method ?? 'POS';
    this.WindowSeconds = Options.WindowSeconds ?? DefaultWindowSeconds;
    this.RawWaveEnabled = false;
    this.Resampler = new Resampler(SampleRate, MaxGapSeconds);
    this.HeartBand = bandpass(MinBpm / 60, MaxBpm / 60, SampleRate);
    this.BeatTracker = new BeatTracker();
    // Every field is declared here with its type; resetSession() and restartTraces() refill them.
    /** @type {number | null} */
    this.SessionStart = null;
    /** @type {EstimateLogEntry[]} */
    this.EstimateLog = [];
    /** Every resampled sample of the session, for export. @type {{ Times: number[], Channels: number[][] }} */
    this.RawLog = { Times: [], Channels: [] };
    /** @type {{ Time: number, Rate: number, Confidence: number }[]} */
    this.RespirationLog = [];
    /** @type {Record<string, { R: number, G: number, B: number, Count: number }>} */
    this.LastColors = {};
    /** @type {HrvResult | null} */
    this.Hrv = null;
    this.HrvProgress = 0;
    /** @type {EngineSnapshot['SessionStats']} */
    this.SessionStats = null;
    /** @type {EngineSnapshot['Trend']} */
    this.Trend = null;
    /** @type {EngineSnapshot['LatestColor']} */
    this.LatestColor = null;
    /** @type {number[]} */
    this.Times = [];
    /** @type {number[][]} */
    this.Channels = [];
    /** @type {number | null} */
    this.DisplayBpm = null;
    /** @type {Record<MethodName, number | null>} */
    this.PreviousBpm = { POS: null, CHROM: null, Green: null };
    this.LastSampleTime = -Infinity;
    this.NextEstimateAt = 0;
    this.NextSlowEstimateAt = 0;
    this.Dirty = false;
    /** @type {EngineSnapshot['MethodResults']} */
    this.MethodResults = { POS: null, CHROM: null, Green: null };
    /** @type {EngineSnapshot['RegionQuality']} */
    this.RegionQuality = { Forehead: null, LeftCheek: null, RightCheek: null };
    /** @type {EngineSnapshot['Wave']} */
    this.Wave = null;
    /** @type {EngineSnapshot['RawWave']} */
    this.RawWave = null;
    this.LatestPulse = 0;
    /** @type {RespirationResult | null} */
    this.Respiration = null;
    /** @type {number[]} */
    this.PendingBeats = [];
    this.resetSession();
  }

  /** @param {MethodName} Name */
  setMethod(Name) {
    if (!Methods[Name]) throw new Error(`Unknown method ${Name}`);
    this.Method = Name;
    this.DisplayBpm = null;
    this.NextEstimateAt = 0;
  }

  /** @param {number} Seconds */
  setWindowSeconds(Seconds) {
    this.WindowSeconds = clamp(Seconds, 5, 30);
    this.NextEstimateAt = 0;
  }

  /** @param {boolean} Enabled */
  setRawWave(Enabled) {
    this.RawWaveEnabled = Enabled;
  }

  resetSession() {
    this.SessionStart = null;
    this.EstimateLog = [];
    this.RawLog = { Times: [], Channels: Array.from({ length: ChannelCount }, () => []) };
    this.RespirationLog = [];
    this.LastColors = {};
    this.Hrv = null;
    this.HrvProgress = 0;
    this.SessionStats = null;
    this.Trend = null;
    this.LatestColor = null;
    this.BeatTracker.reset();
    this.restartTraces(true);
  }

  /**
   * Clears the continuous traces (after a gap) but keeps the session log.
   * @param {boolean} ResetResampler
   */
  restartTraces(ResetResampler) {
    this.Times = [];
    this.Channels = Array.from({ length: ChannelCount }, () => []);
    this.DisplayBpm = null;
    this.PreviousBpm = { POS: null, CHROM: null, Green: null };
    this.LastSampleTime = -Infinity;
    this.NextEstimateAt = 0;
    this.NextSlowEstimateAt = 0;
    this.Dirty = false;
    this.MethodResults = { POS: null, CHROM: null, Green: null };
    this.RegionQuality = { Forehead: null, LeftCheek: null, RightCheek: null };
    this.Wave = null;
    this.RawWave = null;
    this.LatestPulse = 0;
    this.Respiration = null;
    this.PendingBeats = [];
    if (ResetResampler) this.Resampler.reset();
  }

  /**
   * Adds one camera frame's measurements.
   * @param {number} Time Seconds (any monotonic clock).
   * @param {Observation} Observation
   */
  push(Time, Observation) {
    if (this.SessionStart === null) this.SessionStart = Time;
    /** @type {number[]} */
    const Vector = [];
    let SumR = 0;
    let SumG = 0;
    let SumB = 0;
    let SumCount = 0;
    /** @type {number[]} */
    const RegionValues = [];
    for (const Name of RegionList) {
      const Color = Observation.Regions[Name];
      if (Color && Color.Count > 0) {
        this.LastColors[Name] = Color;
        SumR += Color.R * Color.Count;
        SumG += Color.G * Color.Count;
        SumB += Color.B * Color.Count;
        SumCount += Color.Count;
      }
      const Held = this.LastColors[Name] ?? Color;
      RegionValues.push(Held?.R ?? 0, Held?.G ?? 0, Held?.B ?? 0);
    }
    if (SumCount === 0) return; // Nothing visible this frame.
    Vector.push(SumR / SumCount, SumG / SumCount, SumB / SumCount, ...RegionValues);
    Vector.push(Observation.FaceHeight > 0 ? Observation.FaceY / Observation.FaceHeight : 0);
    this.LatestColor = { R: SumR / SumCount, G: SumG / SumCount, B: SumB / SumCount, Pixels: SumCount };

    const { Restarted, Samples } = this.Resampler.push(Time, Vector);
    if (Restarted) this.restartTraces(false);
    for (const Sample of Samples) this.appendSample(Sample.Time, Sample.Values);
    this.LastSampleTime = Time;
  }

  /** @param {number} Time @param {Float64Array} Values */
  appendSample(Time, Values) {
    this.Times.push(Time);
    for (let Channel = 0; Channel < ChannelCount; Channel++) this.Channels[Channel].push(Values[Channel]);
    const Limit = TraceHistorySeconds * SampleRate;
    if (this.Times.length > Limit + SampleRate * 10) {
      const Excess = this.Times.length - Limit;
      this.Times.splice(0, Excess);
      for (const Channel of this.Channels) Channel.splice(0, Excess);
    }
    const Log = this.RawLog;
    Log.Times.push(Time);
    for (let Channel = 0; Channel < ChannelCount; Channel++) Log.Channels[Channel].push(Values[Channel]);
    const SessionLimit = MaxSessionSeconds * SampleRate;
    if (Log.Times.length > SessionLimit + SampleRate * 60) {
      const Excess = Log.Times.length - SessionLimit;
      Log.Times.splice(0, Excess);
      for (const Channel of Log.Channels) Channel.splice(0, Excess);
    }
    this.Dirty = true;
  }

  /**
   * Last Count samples of one trace as R, G, B arrays.
   * @param {number} TraceIndex 0 = combined, 1.. = regions in RegionList order.
   * @param {number} Count
   */
  traceTail(TraceIndex, Count) {
    const Start = Math.max(0, this.Times.length - Count);
    const Base = TraceIndex * 3;
    return {
      R: Float64Array.from(this.Channels[Base].slice(Start)),
      G: Float64Array.from(this.Channels[Base + 1].slice(Start)),
      B: Float64Array.from(this.Channels[Base + 2].slice(Start)),
    };
  }

  /**
   * Pulse signal of one trace over the last Count samples (plus filter padding),
   * band-passed and trimmed back to Count.
   * @param {MethodName} Name
   * @param {number} TraceIndex
   * @param {number} Count
   */
  pulseTail(Name, TraceIndex, Count) {
    const Padded = Math.min(this.Times.length, Count + PadSeconds * SampleRate);
    const { R, G, B } = this.traceTail(TraceIndex, Padded);
    const Raw = Methods[Name].extract(R, G, B, SampleRate);
    const Filtered = filtfilt(this.HeartBand, Raw, 3 * SampleRate);
    return Filtered.subarray(Math.max(0, Filtered.length - Count));
  }

  /**
   * Recomputes whatever is due and returns a snapshot for the UI.
   * @param {number} Now Seconds, same clock as push().
   * @returns {EngineSnapshot}
   */
  update(Now) {
    const Collected = this.Times.length / SampleRate;
    const Stale = Now - this.LastSampleTime > MaxGapSeconds;
    if (this.Dirty && Collected >= 3) this.updateWave();
    if (Collected >= 5 && !Stale && Now >= this.NextEstimateAt) {
      this.NextEstimateAt = Now + EstimateIntervalSeconds;
      this.updateEstimates(Now, Collected);
    }
    if (!Stale && Now >= this.NextSlowEstimateAt && Collected >= 5) {
      this.NextSlowEstimateAt = Now + SlowEstimateIntervalSeconds;
      this.updateSlowEstimates(Now, Collected);
    }
    this.Dirty = false;

    /** @type {EngineSnapshot['Phase']} */
    let Phase = 'Measuring';
    if (Stale || this.Times.length === 0) Phase = 'Searching';
    else if (Collected < CalibrationSeconds || this.DisplayBpm === null) Phase = 'Calibrating';

    const Selected = this.MethodResults[this.Method];
    const NewBeats = this.PendingBeats;
    this.PendingBeats = [];
    const WaveStart = this.Wave ? this.Wave.StartTime : Now;
    const AllBeats = this.BeatTracker.Beats;
    let FirstVisible = AllBeats.length;
    while (FirstVisible > 0 && AllBeats[FirstVisible - 1] >= WaveStart) FirstVisible--;
    return {
      Phase,
      CalibrationProgress: clamp(Collected / CalibrationSeconds, 0, 1),
      SecondsCollected: Collected,
      SessionSeconds: this.SessionStart === null ? 0 : Now - this.SessionStart,
      Bpm: Phase === 'Measuring' ? this.DisplayBpm : null,
      RawBpm: Selected ? Selected.Bpm : null,
      Snr: Selected ? Selected.Snr : -Infinity,
      Confidence: Selected && Phase !== 'Searching' ? Selected.Confidence : 0,
      Method: this.Method,
      MethodResults: this.MethodResults,
      Agreement: this.agreement(),
      RegionQuality: this.RegionQuality,
      Wave: this.Wave,
      RawWave: this.RawWaveEnabled ? this.RawWave : null,
      LatestPulse: Stale ? 0 : this.LatestPulse,
      Beats: AllBeats.slice(FirstVisible),
      NewBeats,
      BeatCount: this.BeatTracker.Beats.length,
      Hrv: this.Hrv,
      HrvProgress: this.HrvProgress,
      Respiration: this.Respiration,
      RespirationProgress: clamp(Collected / RespirationMinSeconds, 0, 1),
      SessionStats: this.SessionStats,
      Trend: this.Trend,
      LatestColor: this.LatestColor,
      Now,
      SessionStart: this.SessionStart ?? Now,
    };
  }

  updateWave() {
    const Count = Math.min(this.Times.length, (WaveSeconds + 2) * SampleRate);
    const Pulse = this.pulseTail(this.Method, 0, Count);
    const Scale = robustStd(Pulse) || 1;
    const Values = new Float32Array(Pulse.length);
    for (let Index = 0; Index < Pulse.length; Index++) Values[Index] = Pulse[Index] / Scale;
    const StartTime = this.Times[this.Times.length - Count];
    this.Wave = { Values, StartTime, Rate: SampleRate };
    this.LatestPulse = Values.length ? Values[Values.length - 1] : 0;
    const Newest = this.Times[this.Times.length - 1];
    const Confirmed = this.BeatTracker.update(Values, StartTime, SampleRate, Newest, this.DisplayBpm ?? this.PreviousBpm[this.Method]);
    this.PendingBeats.push(...Confirmed);

    if (this.RawWaveEnabled) {
      const Padded = Math.min(this.Times.length, Count + PadSeconds * SampleRate);
      const Trace = this.traceTail(0, Padded);
      /** @param {Float64Array} Channel */
      const percent = (Channel) => {
        const Mean = mean(Channel) || 1;
        const Relative = Channel.map((Value) => (Value / Mean - 1) * 100);
        const Filtered = filtfilt(this.HeartBand, Relative, 3 * SampleRate);
        return Float32Array.from(Filtered.subarray(Filtered.length - Count));
      };
      this.RawWave = { R: percent(Trace.R), G: percent(Trace.G), B: percent(Trace.B), StartTime, Rate: SampleRate };
    }
  }

  /** @param {number} Now @param {number} Collected */
  updateEstimates(Now, Collected) {
    const Count = Math.min(this.Times.length, Math.round(this.WindowSeconds * SampleRate));
    for (const Name of MethodNames) {
      const Pulse = this.pulseTail(Name, 0, Count);
      const Result = estimateRate(Pulse, SampleRate, { MinBpm, MaxBpm, PreviousBpm: this.PreviousBpm[Name] });
      this.MethodResults[Name] = Result;
      if (Result.Confidence > 0) this.PreviousBpm[Name] = Result.Bpm;
    }
    const Selected = /** @type {MethodResult} */ (this.MethodResults[this.Method]);

    RegionList.forEach((Name, Index) => {
      const Pulse = this.pulseTail(this.Method, Index + 1, Count);
      const Result = estimateRate(Pulse, SampleRate, { MinBpm, MaxBpm, PreviousBpm: Selected.Bpm });
      const Pixels = this.LastColors[Name]?.Count ?? 0;
      this.RegionQuality[Name] = { Snr: Result.Snr, Confidence: Pixels > 0 ? Result.Confidence : 0, Pixels };
    });

    // Smooth the displayed number; trust confident estimates more.
    if (Selected.Confidence > 0.02) {
      if (this.DisplayBpm === null) {
        if (Collected >= CalibrationSeconds - 1) this.DisplayBpm = Selected.Bpm;
      } else {
        const Weight = 0.15 + 0.45 * Selected.Confidence;
        this.DisplayBpm += Weight * (Selected.Bpm - this.DisplayBpm);
      }
    }
    this.EstimateLog.push({
      Time: Now,
      Bpm: this.DisplayBpm,
      RawBpm: Selected.Bpm,
      Snr: Selected.Snr,
      Confidence: Selected.Confidence,
      MethodBpms: {
        POS: this.MethodResults.POS?.Bpm ?? null,
        CHROM: this.MethodResults.CHROM?.Bpm ?? null,
        Green: this.MethodResults.Green?.Bpm ?? null,
      },
    });
    if (this.EstimateLog.length > (MaxSessionSeconds / EstimateIntervalSeconds) * 1.1) this.EstimateLog.shift();
    this.SessionStats = this.sessionStats();
    this.Trend = this.trend();
  }

  /** @param {number} Now @param {number} Collected */
  updateSlowEstimates(Now, Collected) {
    const Hrv = computeHrv(this.BeatTracker.Beats, HrvWindowSeconds);
    this.Hrv = Hrv && Hrv.ValidBeats >= HrvMinBeats ? Hrv : null;
    this.HrvProgress = clamp((Hrv ? Hrv.ValidBeats : this.recentBeatCount()) / HrvMinBeats, 0, 1);
    if (Collected >= RespirationMinSeconds) {
      const Count = Math.min(this.Times.length, RespirationWindowSeconds * SampleRate);
      const Start = this.Times.length - Count;
      const FaceY = Float64Array.from(this.Channels[FaceYChannel].slice(Start));
      const GreenTrace = Float64Array.from(this.Channels[1].slice(Start));
      // Head motion is the cleaner cue; skin brightness also moves with room lighting.
      this.Respiration = estimateRespiration([FaceY, GreenTrace], SampleRate, [1, 0.5]);
      if (this.Respiration) this.RespirationLog.push({ Time: Now, Rate: this.Respiration.Rate, Confidence: this.Respiration.Confidence });
    }
  }

  recentBeatCount() {
    const Beats = this.BeatTracker.Beats;
    if (!Beats.length) return 0;
    const Newest = Beats[Beats.length - 1];
    return Beats.filter((Time) => Time >= Newest - HrvWindowSeconds).length;
  }

  agreement() {
    const Rates = MethodNames.map((Name) => this.MethodResults[Name])
      .filter((Result) => Result && Result.Confidence > 0)
      .map((Result) => /** @type {MethodResult} */ (Result).Bpm);
    if (Rates.length < 2) return 0;
    const Spread = Math.max(...Rates) - Math.min(...Rates);
    return clamp(1 - (Spread - 3) / 12, 0, 1);
  }

  sessionStats() {
    let Min = Infinity;
    let Max = -Infinity;
    let Sum = 0;
    let Count = 0;
    for (const Entry of this.EstimateLog) {
      if (Entry.Bpm === null || Entry.Confidence < 0.25) continue;
      Min = Math.min(Min, Entry.Bpm);
      Max = Math.max(Max, Entry.Bpm);
      Sum += Entry.Bpm;
      Count++;
    }
    return Count ? { Min, Max, Average: Sum / Count } : null;
  }

  trend() {
    const Log = this.EstimateLog;
    if (!Log.length) return null;
    const Now = Log[Log.length - 1].Time;
    const Recent = Log.filter((Entry) => Entry.Bpm !== null && Entry.Time > Now - 10).map((Entry) => /** @type {number} */ (Entry.Bpm));
    const Earlier = Log.filter((Entry) => Entry.Bpm !== null && Entry.Time <= Now - 10 && Entry.Time > Now - 30).map(
      (Entry) => /** @type {number} */ (Entry.Bpm)
    );
    if (Recent.length < 4 || Earlier.length < 8) return null;
    const Change = mean(Recent) - mean(Earlier);
    if (Change > 3) return 'rising';
    if (Change < -3) return 'falling';
    return 'steady';
  }

  /** Column names and rows of every resampled sample, for CSV export. */
  rawExport() {
    const Header = ['time_s'];
    for (const Name of TraceNames) Header.push(`${Name}_R`, `${Name}_G`, `${Name}_B`);
    Header.push('face_y_rel');
    const Start = this.SessionStart ?? 0;
    const Rows = this.RawLog.Times.map((Time, Row) => [Time - Start, ...this.RawLog.Channels.map((Channel) => Channel[Row])]);
    return { Header, Rows };
  }
}
