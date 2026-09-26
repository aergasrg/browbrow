import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SampleRate } from '../src/Config.js';
import { Methods, MethodNames } from '../src/Signal/Methods.js';
import { bandpass, filtfilt } from '../src/Signal/Filters.js';
import { estimateRate } from '../src/Signal/Spectrum.js';
import { BeatTracker, computeHrv, findPeaks } from '../src/Signal/Beats.js';
import { estimateRespiration } from '../src/Signal/Respiration.js';
import { PulseEngine } from '../src/Signal/PulseEngine.js';
import { SyntheticSubject } from '../src/Sim/SyntheticSubject.js';
import { createRandom } from '../src/Signal/Stats.js';

/**
 * Samples a subject at 30 Hz and returns the combined skin color traces.
 * @param {SyntheticSubject} Subject @param {number} From @param {number} Seconds
 */
function combinedTraces(Subject, From, Seconds) {
  const Count = Math.round(Seconds * SampleRate);
  const R = new Float64Array(Count);
  const G = new Float64Array(Count);
  const B = new Float64Array(Count);
  for (let Index = 0; Index < Count; Index++) {
    const { Regions } = Subject.observe(From + Index / SampleRate);
    let Pixels = 0;
    for (const Color of Object.values(Regions)) {
      R[Index] += Color.R * Color.Count;
      G[Index] += Color.G * Color.Count;
      B[Index] += Color.B * Color.Count;
      Pixels += Color.Count;
    }
    R[Index] /= Pixels;
    G[Index] /= Pixels;
    B[Index] /= Pixels;
  }
  return { R, G, B };
}

/**
 * Runs a subject through the full engine with jittery frame times, like a real camera.
 * @param {SyntheticSubject} Subject @param {number} Seconds
 * @param {(Engine: PulseEngine, Snapshot: import('../src/Signal/PulseEngine.js').EngineSnapshot) => void} [onUpdate]
 */
function runEngine(Subject, Seconds, onUpdate, Engine = new PulseEngine()) {
  const Random = createRandom(11);
  let Time = 0;
  let Snapshot = Engine.update(0);
  while (Time < Seconds) {
    Engine.push(Time, Subject.observe(Time));
    Snapshot = Engine.update(Time);
    onUpdate?.(Engine, Snapshot);
    Time += 1 / 29 + (Random.next() - 0.5) * 0.012;
  }
  return Snapshot;
}

const Band = bandpass(0.7, 4, SampleRate);

for (const Name of MethodNames) {
  test(`${Name} recovers the heart rate of a still subject`, () => {
    const Subject = new SyntheticSubject({ BaseBpm: 66, DriftBpm: 0, RsaBpm: 0 });
    const { R, G, B } = combinedTraces(Subject, 20, 10);
    const Pulse = filtfilt(Band, Methods[Name].extract(R, G, B, SampleRate), 90);
    const Result = estimateRate(Pulse, SampleRate, { MinBpm: 42, MaxBpm: 240 });
    assert.ok(Math.abs(Result.Bpm - 66) < 1.5, `${Name}: ${Result.Bpm.toFixed(1)} BPM`);
    assert.ok(Result.Confidence > 0.5, `${Name}: confidence ${Result.Confidence.toFixed(2)}`);
  });
}

test('POS and CHROM survive a motion burst that fools the green channel', () => {
  // Motion swings brightness and specular glare at 1.3 Hz (78 BPM), inside the heart band.
  const Subject = new SyntheticSubject({ BaseBpm: 104, DriftBpm: 0, RsaBpm: 0, MotionEvery: 10, NoiseLevel: 0.0005 });
  const { R, G, B } = combinedTraces(Subject, 2, 10); // Covers the burst at 6..7.5 s.
  /** @param {import('../src/Signal/Methods.js').MethodName} Name */
  const rate = (Name) => estimateRate(filtfilt(Band, Methods[Name].extract(R, G, B, SampleRate), 90), SampleRate, { MinBpm: 42, MaxBpm: 240 }).Bpm;
  assert.ok(Math.abs(rate('POS') - 104) < 2, `POS ${rate('POS').toFixed(1)}`);
  assert.ok(Math.abs(rate('CHROM') - 104) < 2, `CHROM ${rate('CHROM').toFixed(1)}`);
  assert.ok(Math.abs(rate('Green') - 104) > 5, `Green should be fooled, got ${rate('Green').toFixed(1)}`);
});

test('pulse peaks line up with systole for every method', () => {
  const Subject = new SyntheticSubject({ BaseBpm: 60, DriftBpm: 0, RsaBpm: 0, NoiseLevel: 0.0002 });
  const { R, G, B } = combinedTraces(Subject, 0, 12);
  const Truth = Subject.beatTimesBetween(3, 9);
  for (const Name of MethodNames) {
    const Pulse = filtfilt(Band, Methods[Name].extract(R, G, B, SampleRate), 90);
    const Peaks = findPeaks(Pulse, 0.6 * SampleRate, 0).map((Peak) => Peak.Position / SampleRate).filter((Time) => Time > 2.5 && Time < 9.5);
    for (const Beat of Truth) {
      const Nearest = Peaks.reduce((Best, Time) => (Math.abs(Time - Beat) < Math.abs(Best - Beat) ? Time : Best), Infinity);
      // Band-passing rounds the PPG shape, so allow some lag; an inverted signal would be ~0.5 s off.
      assert.ok(Math.abs(Nearest - Beat) < 0.12, `${Name}: beat at ${Beat.toFixed(2)} nearest peak ${Nearest.toFixed(2)}`);
    }
  }
});

test('HRV from a known interval series', () => {
  const Intervals = [0.8, 0.85, 0.8, 0.85, 0.8, 0.85, 0.8];
  const Beats = [10];
  for (const Interval of Intervals) Beats.push(Beats[Beats.length - 1] + Interval);
  const Result = computeHrv(Beats, 60);
  assert.ok(Result);
  assert.ok(Math.abs(Result.Rmssd - 50) < 1e-6, `RMSSD ${Result.Rmssd}`);
  assert.ok(Math.abs(Result.MeanIbi - (0.8 * 4 + 0.85 * 3) / 7 * 1000) < 1e-6);
  assert.equal(Result.Pairs.length, 6);
  // A missed beat (double interval) is rejected instead of wrecking RMSSD.
  const Missed = [...Beats.slice(0, 4), ...Beats.slice(5)];
  const WithMiss = computeHrv(Missed, 60);
  assert.ok(WithMiss && WithMiss.Rmssd < 60, `RMSSD with missed beat ${WithMiss?.Rmssd}`);
});

test('breathing rate from head motion and skin brightness', () => {
  const Subject = new SyntheticSubject({ BreathsPerMinute: 12 });
  const Count = 32 * SampleRate;
  const FaceY = new Float64Array(Count);
  const GreenTrace = new Float64Array(Count);
  for (let Index = 0; Index < Count; Index++) {
    const Observation = Subject.observe(5 + Index / SampleRate);
    FaceY[Index] = Observation.FaceY / Observation.FaceHeight;
    GreenTrace[Index] = Observation.Regions.Forehead.G;
  }
  const Result = estimateRespiration([FaceY, GreenTrace], SampleRate, [1, 0.5]);
  assert.ok(Result);
  assert.ok(Math.abs(Result.Rate - 12) < 1, `breathing ${Result.Rate.toFixed(1)}`);
  assert.ok(Result.Confidence > 0.3, `confidence ${Result.Confidence}`);
});

test('engine: calibrates, then tracks a drifting heart rate', () => {
  const Subject = new SyntheticSubject({ BaseBpm: 75, DriftBpm: 6, DriftPeriod: 60 });
  /** @type {string[]} */
  const Phases = [];
  /** @type {number[]} */
  const Errors = [];
  const Final = runEngine(Subject, 70, (_Engine, Snapshot) => {
    if (Phases[Phases.length - 1] !== Snapshot.Phase) Phases.push(Snapshot.Phase);
    if (Snapshot.Bpm !== null && Snapshot.SessionSeconds > 15) {
      // Compare with the true rate averaged over the estimation window.
      let Sum = 0;
      for (let Step = 0; Step < 10; Step++) Sum += Subject.heartRateAt(Snapshot.Now - Step);
      Errors.push(Math.abs(Snapshot.Bpm - Sum / 10));
    }
  });
  assert.equal(new PulseEngine().update(0).Phase, 'Searching');
  assert.deepEqual(Phases.slice(0, 2), ['Calibrating', 'Measuring']);
  const MeanError = Errors.reduce((Sum, Value) => Sum + Value, 0) / Errors.length;
  assert.ok(MeanError < 2, `mean error ${MeanError.toFixed(2)} BPM`);
  assert.ok(Final.Confidence > 0.5, `confidence ${Final.Confidence}`);
  assert.ok(Final.Agreement > 0.5, `agreement ${Final.Agreement}`);
  assert.ok(Final.SessionStats && Final.SessionStats.Min < Final.SessionStats.Max);
  for (const Quality of Object.values(Final.RegionQuality)) assert.ok(Quality && Quality.Confidence > 0.3);
  assert.ok(Final.Respiration && Math.abs(Final.Respiration.Rate - 14) < 1.5, `breathing ${Final.Respiration?.Rate}`);
  assert.ok(Final.Hrv, 'HRV available after a minute');
  assert.ok(Final.Wave && Final.Wave.Values.length > 0);
});

test('engine: beat times match the true heartbeats', () => {
  const Subject = new SyntheticSubject({ BaseBpm: 68, NoiseLevel: 0.0004 });
  const Engine = new PulseEngine();
  runEngine(Subject, 40, undefined, Engine);
  const Detected = Engine.BeatTracker.Beats.filter((Time) => Time > 10 && Time < 38);
  const Truth = Subject.beatTimesBetween(10.5, 37.5);
  let Matched = 0;
  for (const Beat of Truth) {
    if (Detected.some((Time) => Math.abs(Time - Beat) < 0.12)) Matched++;
  }
  assert.ok(Matched / Truth.length > 0.9, `matched ${Matched} of ${Truth.length}`);
  assert.ok(Detected.length <= Truth.length * 1.1, `too many beats: ${Detected.length} vs ${Truth.length}`);
});

test('engine: restarts after the face is lost, keeping the session log', () => {
  const Subject = new SyntheticSubject({ BaseBpm: 80 });
  const Engine = new PulseEngine();
  runEngine(Subject, 15, undefined, Engine);
  const LogLength = Engine.EstimateLog.length;
  assert.equal(Engine.update(15.2).Phase, 'Measuring');
  assert.equal(Engine.update(17).Phase, 'Searching');
  Engine.push(20, Subject.observe(20));
  const After = Engine.update(20);
  assert.equal(After.Phase, 'Calibrating');
  assert.ok(After.SecondsCollected < 0.1);
  assert.equal(Engine.EstimateLog.length, LogLength);
  assert.ok(After.SessionSeconds > 19);
});

test('engine: switching methods and exporting', () => {
  const Engine = new PulseEngine({ Method: 'CHROM' });
  runEngine(new SyntheticSubject({ BaseBpm: 90 }), 14, undefined, Engine);
  const Snapshot = Engine.update(14);
  assert.equal(Snapshot.Method, 'CHROM');
  assert.ok(Snapshot.Bpm !== null && Math.abs(Snapshot.Bpm - 90) < 6, `CHROM ${Snapshot.Bpm}`);
  Engine.setRawWave(true);
  Engine.push(14.05, new SyntheticSubject({ BaseBpm: 90 }).observe(14.05));
  const WithRaw = Engine.update(14.05);
  assert.ok(WithRaw.RawWave && WithRaw.RawWave.G.length === WithRaw.Wave?.Values.length);
  const { Header, Rows } = Engine.rawExport();
  assert.equal(Header.length, Rows[0].length);
  assert.ok(Rows.length > 13 * SampleRate);
});

test('beat tracker waits before confirming and never double counts', () => {
  const Tracker = new BeatTracker(0.4);
  const Signal = Float64Array.from({ length: 300 }, (_, Index) => Math.cos(2 * Math.PI * (Index / 30)));
  const First = Tracker.update(Signal, 0, 30, 10, 60);
  assert.ok(First.every((Time) => Time <= 9.6));
  const Again = Tracker.update(Signal, 0, 30, 10, 60);
  assert.equal(Again.length, 0, 'same window twice adds nothing');
  assert.deepEqual(First.map((Time) => Math.round(Time)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('darker skin: weaker pulse, still measured by POS and CHROM', () => {
  // Melanin absorbs more light, lowering both brightness and pulse strength.
  const Subject = new SyntheticSubject({ BaseBpm: 81, DriftBpm: 0, RsaBpm: 0, SkinTone: [92, 62, 50], PulseAmplitude: 0.002 });
  const { R, G, B } = combinedTraces(Subject, 5, 10);
  for (const Name of /** @type {const} */ (['POS', 'CHROM'])) {
    const Result = estimateRate(filtfilt(Band, Methods[Name].extract(R, G, B, SampleRate), 90), SampleRate, { MinBpm: 42, MaxBpm: 240 });
    assert.ok(Math.abs(Result.Bpm - 81) < 2, `${Name}: ${Result.Bpm.toFixed(1)}`);
  }
});
