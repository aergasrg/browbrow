// The app controller: owns the camera, face tracker, measurement engine and
// all views, and runs the frame loop.

import { CameraError, CameraSource, ScreenWakeLock } from './Camera/CameraSource.js';
import { PulseMagnifier } from './Magnify/PulseMagnifier.js';
import { Settings } from './Settings.js';
import { PulseEngine } from './Signal/PulseEngine.js';
import { createRandom } from './Signal/Stats.js';
import { DemoFrame, demoLandmarks } from './Sim/DemoFace.js';
import { SyntheticSubject } from './Sim/SyntheticSubject.js';
import { loadTheme } from './Ui/Canvas.js';
import { SpectrumChart, TrendChart, WaveChart } from './Ui/Charts.js';
import { HrvDialog, SettingsDialog, SummaryDialog, VerifyDialog } from './Ui/Dialogs.js';
import { byId, setText } from './Ui/Dom.js';
import { HeroPanel, LabPanel, StagePanel, StatsPanel } from './Ui/Panels.js';
import { StageOverlay } from './Ui/StageOverlay.js';
import { StartScreen } from './Ui/StartScreen.js';
import { FaceTracker } from './Vision/FaceTracker.js';
import { SceneChecks } from './Vision/SceneChecks.js';
import { SkinSampler } from './Vision/SkinSampler.js';

/** @typedef {import('./Settings.js').SettingsValues} SettingsValues */
/** @typedef {import('./Ui/Dialogs.js').VerifyResult} VerifyResult */

const LandmarkHoldSeconds = 0.3;

export class App {
  constructor() {
    loadTheme();
    this.Settings = new Settings();
    const Values = this.Settings.Values;
    this.Engine = new PulseEngine({ Method: Values.Method, WindowSeconds: Values.WindowSeconds });
    this.Engine.setRawWave(Values.RawWave);
    this.Scene = new SceneChecks();
    this.SceneState = this.Scene.state(0);
    this.Video = /** @type {HTMLVideoElement} */ (byId('video'));
    this.Camera = new CameraSource(this.Video);
    this.WakeLock = new ScreenWakeLock();
    /** @type {FaceTracker | null} */
    this.Tracker = null;
    /** @type {Promise<FaceTracker> | null} */
    this.TrackerPromise = null;
    /** @type {SkinSampler | null} */
    this.Sampler = null;
    /** @type {PulseMagnifier | null} */
    this.Magnifier = null;
    try {
      this.Magnifier = new PulseMagnifier(/** @type {HTMLCanvasElement} */ (byId('magnify-canvas')));
      this.Magnifier.setGain(Values.MagnifyGain);
    } catch (Failure) {
      console.warn('Magnify view unavailable:', Failure);
    }

    /** @type {'idle' | 'live' | 'demo'} */
    this.Mode = 'idle';
    this.Running = false;
    /** @type {string | null} */
    this.Loading = null;
    this.Landmarks = new Float32Array(478 * 2);
    this.LandmarksAt = -Infinity;
    this.FrameWidth = 640;
    this.FrameHeight = 480;
    this.Mirrored = true;
    this.CameraLabel = '--';
    this.FramesAnalyzed = 0;
    this.FrameCounter = 0;
    this.DetectEvery = 1;
    /** @type {VerifyResult | null} */
    this.Verify = null;
    this.Snapshot = this.Engine.update(0);
    this.LastSlowUpdate = 0;
    this.LastTrendUpdate = 0;
    /** @type {SyntheticSubject | null} */
    this.Subject = null;
    this.DemoStart = 0;
    this.DemoNext = 0;
    this.DemoRandom = createRandom(Date.now() & 0xffff);
    this.LoopStarted = false;
    this.Changing = false;
    /** @type {'Normal' | 'Pulse' | 'Magnify'} */
    this.View = 'Normal';

    this.AppRoot = byId('app');
    this.Monitor = byId('monitor');
    this.Stage = byId('stage');
    this.StartScreen = new StartScreen();
    this.Hero = new HeroPanel();
    this.StagePanel = new StagePanel();
    this.Stats = new StatsPanel();
    this.Lab = new LabPanel((Name) => this.Settings.set({ Method: Name }));
    this.Overlay = new StageOverlay(/** @type {HTMLCanvasElement} */ (byId('overlay-canvas')));
    this.Wave = new WaveChart(/** @type {HTMLCanvasElement} */ (byId('wave-canvas')));
    this.Spectrum = new SpectrumChart(/** @type {HTMLCanvasElement} */ (byId('spectrum-canvas')));
    this.Trend = new TrendChart(/** @type {HTMLCanvasElement} */ (byId('trend-canvas')));
    this.VerifyDialog = new VerifyDialog((Result) => (this.Verify = Result));
    this.SummaryDialog = new SummaryDialog(
      () => ({ Engine: this.Engine, Snapshot: this.Snapshot, Verify: this.Verify, Demo: this.Mode === 'demo' }),
      () => this.newSession()
    );
    this.HrvDialog = new HrvDialog();
    this.SettingsDialog = new SettingsDialog(this.Settings, { MagnifyAvailable: Boolean(this.Magnifier) });

    /** Canvases currently on screen; off-screen charts are not redrawn. @type {Set<Element>} */
    this.OnScreen = new Set();
    const Watcher = new IntersectionObserver(
      (Entries) => Entries.forEach((Entry) => (Entry.isIntersecting ? this.OnScreen.add(Entry.target) : this.OnScreen.delete(Entry.target))),
      { rootMargin: '80px' }
    );
    for (const Id of ['wave-canvas', 'spectrum-canvas', 'trend-canvas', 'lab']) Watcher.observe(byId(Id));
  }

  init() {
    this.bindEvents();
    this.Settings.subscribe((Values, Changed) => this.applySettings(Values, Changed));
    this.applySettings(this.Settings.Values, /** @type {(keyof SettingsValues)[]} */ (Object.keys(this.Settings.Values)));
    this.StartScreen.show();
    if (!window.isSecureContext) {
      this.StartScreen.setError(
        '<b>This page needs HTTPS for the camera.</b> Open it with an <code>https://</code> address. The demo still works here.'
      );
    }
    if (new URLSearchParams(location.search).has('demo')) this.startDemo();
  }

  bindEvents() {
    byId('start-button').addEventListener('click', () => this.startLive());
    byId('demo-button').addEventListener('click', () => this.startDemo());
    byId('run-button').addEventListener('click', () => (this.Running ? this.stop() : this.resume()));
    byId('verify-button').addEventListener('click', () => this.VerifyDialog.open());
    byId('summary-button').addEventListener('click', () => this.SummaryDialog.open());
    byId('settings-button').addEventListener('click', () => this.SettingsDialog.open());
    byId('light-button').addEventListener('click', () => this.setLight(true));
    byId('light-exit').addEventListener('click', () => this.setLight(false));
    byId('lab-jump').addEventListener('click', () => byId('lab').scrollIntoView({ behavior: 'smooth', block: 'start' }));
    byId('raw-toggle').addEventListener('click', () => this.Settings.set({ RawWave: !this.Settings.Values.RawWave }));
    byId('hrv-expand').addEventListener('click', () => {
      this.HrvDialog.open();
      requestAnimationFrame(() => this.HrvDialog.update(this.Snapshot));
    });
    for (const Button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#view-switch button'))) {
      Button.addEventListener('click', () => this.Settings.set({ View: /** @type {SettingsValues['View']} */ (Button.dataset.view) }));
    }
    document.addEventListener('keydown', (Event) => {
      if (Event.key === 'Escape' && this.AppRoot.classList.contains('light-on')) this.setLight(false);
    });
  }

  /** @param {SettingsValues} Values @param {(keyof SettingsValues)[]} Changed */
  applySettings(Values, Changed) {
    if (Changed.includes('Method')) {
      this.Engine.setMethod(Values.Method);
      this.Lab.select(Values.Method);
    }
    if (Changed.includes('WindowSeconds')) this.Engine.setWindowSeconds(Values.WindowSeconds);
    if (Changed.includes('MagnifyGain')) this.Magnifier?.setGain(Values.MagnifyGain);
    if (Changed.includes('ReduceMotion')) this.AppRoot.classList.toggle('reduce-motion', Values.ReduceMotion);
    if (Changed.includes('RawWave')) {
      this.Engine.setRawWave(Values.RawWave);
      byId('raw-toggle').setAttribute('aria-pressed', String(Values.RawWave));
      byId('rgb-legend').hidden = !Values.RawWave;
      byId('wave-foot').hidden = Values.RawWave;
    }
    if (Changed.includes('View')) this.applyView();
    if (Changed.includes('CameraId') && this.Mode === 'live' && this.Running && !this.Changing) this.restartCamera();
  }

  applyView() {
    const Requested = this.Settings.Values.View;
    const MagnifyPossible = Boolean(this.Magnifier) && this.Mode !== 'demo';
    const View = Requested === 'Magnify' && !MagnifyPossible ? 'Pulse' : Requested;
    for (const Button of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#view-switch button'))) {
      Button.setAttribute('aria-checked', String(Button.dataset.view === View));
      if (Button.dataset.view === 'Magnify') {
        Button.disabled = !MagnifyPossible;
        Button.title = MagnifyPossible ? 'Amplify the color change so you can see your pulse' : 'Needs the live camera';
      }
    }
    const Magnify = View === 'Magnify';
    this.Stage.classList.toggle('magnify', Magnify);
    byId('magnify-canvas').hidden = !Magnify;
    if (Magnify) this.Magnifier?.reset();
    this.View = View;
  }

  /** Loads the face tracker once; later calls share the same promise. */
  loadTracker() {
    if (!this.TrackerPromise) {
      this.TrackerPromise = FaceTracker.create((Stage, Fraction) => {
        this.Loading = `${Stage}… ${Math.round(Fraction * 100)}%`;
        if (this.Mode === 'idle') this.StartScreen.setProgress(this.Loading, Fraction);
      });
      this.TrackerPromise.catch(() => (this.TrackerPromise = null));
    }
    return this.TrackerPromise;
  }

  async startLive() {
    this.StartScreen.setError(null);
    this.StartScreen.setProgress('Starting camera…', 0.02);
    const TrackerReady = this.loadTracker();
    TrackerReady.catch(() => {}); // Handled below.
    try {
      await this.openCamera();
    } catch (Failure) {
      this.StartScreen.setProgress(null);
      this.StartScreen.setError(cameraErrorHtml(Failure));
      return;
    }
    this.enterMonitor('live');
    try {
      this.Tracker = await TrackerReady;
      this.Loading = null;
    } catch (Failure) {
      console.error(Failure);
      this.Camera.stop();
      this.exitToStart(
        '<b>Couldn\'t load the face tracker.</b> Check your internet connection and try again, or try the demo in the meantime.'
      );
      return;
    }
    this.Sampler = this.Sampler ?? new SkinSampler();
    this.Camera.onFrame((Time) => this.onCameraFrame(Time));
  }

  async openCamera() {
    const Values = this.Settings.Values;
    let Info;
    try {
      Info = await this.Camera.start({ DeviceId: Values.CameraId || undefined });
    } catch (Failure) {
      if (Values.CameraId && Failure instanceof CameraError && Failure.Kind === 'missing') {
        this.Changing = true;
        this.Settings.set({ CameraId: '' }); // Saved camera is gone; fall back to the default.
        this.Changing = false;
        Info = await this.Camera.start({});
      } else {
        throw Failure;
      }
    }
    this.FrameWidth = Info.Width;
    this.FrameHeight = Info.Height;
    this.Mirrored = Info.Mirrored;
    this.CameraLabel = `${Info.Width}×${Info.Height}`;
    this.Stage.classList.toggle('mirrored', Info.Mirrored);
  }

  async restartCamera() {
    try {
      await this.openCamera();
      this.Camera.onFrame((Time) => this.onCameraFrame(Time));
    } catch (Failure) {
      this.stop();
      alert(stripTags(cameraErrorHtml(Failure)));
    }
  }

  startDemo() {
    this.StartScreen.setError(null);
    const Random = this.DemoRandom;
    this.Subject = new SyntheticSubject({
      Seed: Math.floor(Random.next() * 1e6),
      BaseBpm: 66 + Random.next() * 12,
      MotionEvery: 36,
      NoiseLevel: 0.0009,
    });
    this.DemoStart = performance.now() / 1000;
    this.DemoNext = this.DemoStart;
    this.FrameWidth = DemoFrame.Width;
    this.FrameHeight = DemoFrame.Height;
    this.Mirrored = true;
    this.CameraLabel = 'simulated';
    this.enterMonitor('demo');
  }

  /** @param {'live' | 'demo'} Mode */
  enterMonitor(Mode) {
    this.Mode = Mode;
    this.Running = true;
    this.StartScreen.hide();
    this.StartScreen.setProgress(null);
    this.Monitor.hidden = false;
    this.AppRoot.dataset.screen = 'monitor';
    this.AppRoot.classList.add('running');
    this.Stage.classList.toggle('demo', Mode === 'demo');
    this.Stage.classList.toggle('mirrored', Mode === 'live' && this.Mirrored);
    this.applyView();
    this.updateRunState();
    this.WakeLock.acquire();
    window.scrollTo(0, 0);
    if (!this.LoopStarted) {
      this.LoopStarted = true;
      requestAnimationFrame(() => this.loop());
    }
  }

  /** @param {string} Html */
  exitToStart(Html) {
    this.Mode = 'idle';
    this.Running = false;
    this.Loading = null;
    this.Monitor.hidden = true;
    this.AppRoot.dataset.screen = 'start';
    this.AppRoot.classList.remove('running');
    this.WakeLock.release();
    this.StartScreen.show();
    this.StartScreen.setProgress(null);
    this.StartScreen.setError(Html);
  }

  stop() {
    if (!this.Running) return;
    this.Running = false;
    if (this.Mode === 'live') this.Camera.stop();
    this.WakeLock.release();
    this.AppRoot.classList.remove('running');
    this.updateRunState();
    if (this.Snapshot.SessionSeconds > 10) this.SummaryDialog.open();
  }

  async resume() {
    if (this.Running) return;
    if (this.Mode === 'live') {
      try {
        await this.openCamera();
      } catch (Failure) {
        alert(stripTags(cameraErrorHtml(Failure)));
        return;
      }
      this.Camera.onFrame((Time) => this.onCameraFrame(Time));
    } else if (this.Mode === 'demo') {
      this.DemoNext = performance.now() / 1000;
    }
    this.Running = true;
    this.AppRoot.classList.add('running');
    this.WakeLock.acquire();
    this.updateRunState();
  }

  newSession() {
    this.Engine.resetSession();
    this.Scene.reset();
    this.Verify = null;
    this.FramesAnalyzed = 0;
    this.Hero.reset();
    if (this.Mode === 'demo' && this.Subject) this.DemoStart = performance.now() / 1000 - 0.001;
    if (!this.Running) this.resume();
  }

  updateRunState() {
    const Button = byId('run-button');
    /** @type {SVGUseElement} */ (Button.querySelector('use')).setAttribute('href', this.Running ? '#i-stop' : '#i-play');
    setText(/** @type {Element} */ (Button.querySelector('span')), this.Running ? 'Stop' : 'Resume');
    Button.classList.toggle('primary', !this.Running);
    const Pill = byId('live-pill');
    Pill.className = `live-pill ${!this.Running ? 'paused' : this.Mode === 'demo' ? 'demo' : 'live'}`;
    setText(byId('live-label'), !this.Running ? 'PAUSED' : this.Mode === 'demo' ? 'DEMO' : 'LIVE');
  }

  /** @param {boolean} On */
  setLight(On) {
    this.AppRoot.classList.toggle('light-on', On);
    byId('light-controls').hidden = !On;
    byId('light-button').setAttribute('aria-pressed', String(On));
    const Theme = /** @type {HTMLMetaElement} */ (document.querySelector('meta[name=theme-color]'));
    Theme.content = On ? '#ffffff' : '#06090d';
    if (On) window.scrollTo(0, 0);
  }

  /** One camera frame: track the face, sample the skin, feed the engine. @param {number} Time */
  onCameraFrame(Time) {
    if (!this.Running || !this.Tracker || !this.Sampler) return;
    const Video = this.Video;
    if (!Video.videoWidth) return;
    this.FrameWidth = Video.videoWidth;
    this.FrameHeight = Video.videoHeight;
    // Face tracking is the expensive step. On a slow device, track every few
    // frames and reuse the last landmarks in between: the face barely moves in
    // 1/30 s, and sampling skin color on every frame keeps the pulse clean.
    const Slow = this.Tracker.LastDetectMs;
    this.DetectEvery = Slow > 22 ? Math.min(4, Math.ceil(Slow / 22)) : 1;
    this.FrameCounter++;
    const Held = performance.now() / 1000 - this.LandmarksAt < 0.25;
    /** @type {Float32Array | null} */
    let Landmarks = this.Landmarks;
    if (!Held || this.FrameCounter % this.DetectEvery === 0) {
      Landmarks = this.Tracker.detect(Video, Time * 1000);
      if (Landmarks) {
        this.Landmarks.set(Landmarks);
        this.LandmarksAt = performance.now() / 1000;
      } else {
        this.LandmarksAt = -Infinity;
      }
    }
    let Observation = null;
    if (Landmarks) {
      Observation = this.Sampler.sample(Video, Video.videoWidth, Video.videoHeight, Landmarks);
      this.Engine.push(Time, Observation);
      this.FramesAnalyzed++;
    }
    this.SceneState = this.Scene.update(Time, Observation);
    if (this.View === 'Magnify' && this.Magnifier) {
      this.Magnifier.process(Video, Time, Landmarks);
      this.Magnifier.render(Video, this.Mirrored);
    }
  }

  /** Demo: generate simulated camera frames up to Now. @param {number} Now */
  demoTick(Now) {
    const Subject = /** @type {SyntheticSubject} */ (this.Subject);
    if (Now - this.DemoNext > 1) this.DemoNext = Now; // Tab was hidden; skip ahead.
    while (this.DemoNext <= Now) {
      const Time = this.DemoNext;
      const Observation = Subject.observe(Time - this.DemoStart);
      this.Engine.push(Time, Observation);
      this.SceneState = this.Scene.update(Time, Observation);
      this.FramesAnalyzed++;
      this.DemoNext += 1 / 30 + (this.DemoRandom.next() - 0.5) * 0.008;
    }
    const SubjectTime = Now - this.DemoStart;
    demoLandmarks(SubjectTime, Subject.breathAt(SubjectTime), Subject.motionAt(SubjectTime), this.Landmarks);
    this.LandmarksAt = Now;
  }

  loop() {
    const Now = performance.now() / 1000;
    try {
      this.frame(Now);
    } catch (Failure) {
      console.error(Failure);
    }
    requestAnimationFrame(() => this.loop());
  }

  /** @param {number} Now */
  frame(Now) {
    if (this.Mode === 'idle') return;
    if (this.Mode === 'demo' && this.Running) this.demoTick(Now);
    if (!this.Running) this.SceneState = this.Scene.state(Now);
    const Snapshot = this.Engine.update(Now);
    this.Snapshot = Snapshot;
    const Values = this.Settings.Values;
    const Loading = this.Mode === 'live' && !this.Tracker ? this.Loading ?? 'Loading face tracker…' : null;
    const HasFace = this.Running && Now - this.LandmarksAt < LandmarkHoldSeconds;

    this.Hero.update(Snapshot, this.Running);
    this.StagePanel.update(Snapshot, this.SceneState, { Running: this.Running, Demo: this.Mode === 'demo', Loading });
    this.Overlay.render({
      Landmarks: HasFace ? this.Landmarks : null,
      FrameWidth: this.FrameWidth,
      FrameHeight: this.FrameHeight,
      Mirrored: this.Mirrored,
      Demo: this.Mode === 'demo',
      View: this.View,
      ShowMesh: Values.ShowMesh,
      ShowZones: Values.ShowZones,
      ShowLabels: Values.ShowLabels,
      RegionQuality: Snapshot.RegionQuality,
      LatestPulse: Snapshot.LatestPulse,
      Time: Now,
    });
    if (this.OnScreen.has(this.Wave.Surface.Canvas)) {
      this.Wave.render({
        Wave: Snapshot.Wave,
        RawWave: Snapshot.RawWave,
        Beats: Snapshot.Beats,
        SessionStart: Snapshot.SessionStart,
        ShowRaw: Values.RawWave,
      });
    }
    this.Stats.animate(Snapshot, Values.ReduceMotion);

    if (Now - this.LastSlowUpdate > 0.25) {
      this.LastSlowUpdate = Now;
      this.Stats.update(Snapshot, this.FramesAnalyzed, this.Engine.BeatTracker.Beats);
      if (this.OnScreen.has(this.Spectrum.Surface.Canvas)) this.Spectrum.render({ Result: Snapshot.MethodResults[Snapshot.Method] });
      if (this.OnScreen.has(byId('lab'))) {
        this.Lab.update(Snapshot, {
          Camera: this.Mode === 'demo' ? 'simulated · 30 fps' : `${this.CameraLabel} · ${Math.round(this.SceneState.Fps)} fps`,
          FaceMs: this.Mode === 'demo' ? null : this.Tracker?.LastDetectMs ?? 0,
          DetectEvery: this.DetectEvery,
          Face: HasFace,
          Pixels: Snapshot.LatestColor?.Pixels ?? 0,
          WindowSeconds: Values.WindowSeconds,
        });
      }
      this.HrvDialog.update(Snapshot);
      if (this.VerifyDialog.isOpen) this.VerifyDialog.setCamera(Snapshot.Bpm);
      this.Magnifier?.setHeartRate(Snapshot.Bpm);
    }
    if (Now - this.LastTrendUpdate > 1 && this.OnScreen.has(this.Trend.Surface.Canvas)) {
      this.LastTrendUpdate = Now;
      this.Trend.render({ Log: this.Engine.EstimateLog, SessionStart: Snapshot.SessionStart, Now });
    }
  }
}

/** @param {unknown} Failure */
function cameraErrorHtml(Failure) {
  if (Failure instanceof CameraError) {
    switch (Failure.Kind) {
      case 'insecure':
        return '<b>The camera needs HTTPS.</b> Open this page with an <code>https://</code> address.';
      case 'denied':
        return (
          '<b>Camera access was blocked.</b> To allow it:<ol>' +
          '<li>iPhone: tap <b>aA</b> in the address bar → Website Settings → Camera → Allow, then reload.</li>' +
          '<li>Or: Settings → Apps → Safari → Camera → Allow.</li>' +
          '<li>Chrome or Edge: click the camera icon in the address bar and allow it.</li></ol>'
        );
      case 'missing':
        return '<b>No camera found.</b> Connect a camera, or try the demo.';
      case 'busy':
        return '<b>The camera is busy.</b> Close other apps or tabs using it (FaceTime, Zoom, another tab) and try again.';
      case 'unsupported':
        return '<b>This browser can\'t use the camera.</b> Try Safari on iPhone, or Chrome or Edge on a computer.';
      default:
        return `<b>Couldn't start the camera.</b> ${escapeHtml(Failure.message)}`;
    }
  }
  return `<b>Something went wrong.</b> ${escapeHtml(String(/** @type {Error} */ (Failure)?.message ?? Failure))}`;
}

/** @param {string} Text */
function escapeHtml(Text) {
  return Text.replace(/[&<>"']/g, (Character) => `&#${Character.charCodeAt(0)};`);
}

/** @param {string} Html */
function stripTags(Html) {
  const Holder = document.createElement('div');
  Holder.innerHTML = Html;
  return Holder.textContent ?? '';
}
