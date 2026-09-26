// The live panels: heart-rate dial, camera status, stat tiles, Algorithm Lab.

import { CalibrationSeconds } from '../Config.js';
import { MethodNames, Methods } from '../Signal/Methods.js';
import { RegionOrder } from '../Vision/Regions.js';
import { Theme } from './Canvas.js';
import { MiniSpectrum, PoincarePlot, Tachogram } from './Charts.js';
import { byId, formatDuration, formatNumber, levelFor, qualityWord, restartAnimation, setData, setText } from './Dom.js';

/** @typedef {import('../Signal/PulseEngine.js').EngineSnapshot} EngineSnapshot */
/** @typedef {import('../Vision/SceneChecks.js').SceneState} SceneState */
/** @typedef {import('../Signal/Methods.js').MethodName} MethodName */

const RingLength = 2 * Math.PI * 84;

export class HeroPanel {
  constructor() {
    this.Card = byId('hero-card');
    this.Dial = byId('dial');
    this.Progress = /** @type {SVGCircleElement} */ (/** @type {unknown} */ (byId('dial-progress')));
    this.Heart = /** @type {HTMLElement} */ (/** @type {unknown} */ (byId('heart')));
    this.Value = byId('bpm-value');
    this.Status = byId('hero-status');
    this.Min = byId('stat-min');
    this.Avg = byId('stat-avg');
    this.Max = byId('stat-max');
    this.TrendTag = byId('trend-tag');
    this.ConfidenceTag = byId('confidence-tag');
    this.MethodTag = byId('method-tag');
    this.TopBpm = byId('topbar-bpm');
    this.TopValue = byId('topbar-bpm-value');
    this.Live = byId('bpm-live');
    this.Shown = /** @type {number | null} */ (null);
    this.LastFrame = performance.now();
    this.LastAnnounced = 0;
    this.buildTicks();
    new IntersectionObserver(([Entry]) => this.TopBpm.classList.toggle('visible', !Entry.isIntersecting), { threshold: 0.2 }).observe(
      this.Card
    );
  }

  buildTicks() {
    const Group = byId('dial-ticks');
    const Namespace = 'http://www.w3.org/2000/svg';
    for (let Tick = 0; Tick < 60; Tick++) {
      const Angle = (Tick / 60) * Math.PI * 2;
      const Major = Tick % 5 === 0;
      const Inner = Major ? 92 : 94;
      const Line = document.createElementNS(Namespace, 'line');
      Line.setAttribute('x1', String(100 + Inner * Math.cos(Angle)));
      Line.setAttribute('y1', String(100 + Inner * Math.sin(Angle)));
      Line.setAttribute('x2', String(100 + 98 * Math.cos(Angle)));
      Line.setAttribute('y2', String(100 + 98 * Math.sin(Angle)));
      if (Major) Line.setAttribute('class', 'major');
      Group.append(Line);
    }
  }

  reset() {
    this.Shown = null;
    setText(this.Value, '--');
    setText(this.TopValue, '--');
  }

  /** @param {EngineSnapshot} Snapshot @param {boolean} Running */
  update(Snapshot, Running) {
    const Now = performance.now();
    const Elapsed = Math.min(0.1, (Now - this.LastFrame) / 1000);
    this.LastFrame = Now;
    if (Snapshot.NewBeats.length) restartAnimation(this.Heart, 'beat');

    const Measuring = Snapshot.Phase === 'Measuring' && Snapshot.Bpm !== null;
    this.Card.classList.toggle('measuring', Measuring);
    let Fraction = 0;
    /** @type {import('./Dom.js').Level | undefined} */
    let Level;
    if (!Running) {
      setText(this.Status, Snapshot.SessionSeconds > 0 ? 'Paused' : 'Ready');
    } else if (Snapshot.Phase === 'Searching') {
      setText(this.Status, 'Looking for your face');
    } else if (!Measuring) {
      Fraction = Snapshot.CalibrationProgress;
      const Remaining = Math.max(1, Math.ceil((1 - Snapshot.CalibrationProgress) * CalibrationSeconds));
      setText(this.Status, Snapshot.CalibrationProgress < 1 ? `Reading your pulse… ${Remaining} s` : 'Locking on…');
    } else {
      Fraction = Math.max(0.06, Snapshot.Confidence);
      Level = levelFor(Snapshot.Confidence);
      setText(
        this.Status,
        Level === 'good' ? 'Strong signal. Nice and steady.' : Level === 'warn' ? 'Fair signal. Keep still.' : 'Weak signal. More light may help.'
      );
    }
    setData(this.Dial, 'level', Level);
    this.Progress.style.strokeDashoffset = String(RingLength * (1 - Fraction));

    if (Measuring && Snapshot.Bpm !== null) {
      const Target = Snapshot.Bpm;
      this.Shown = this.Shown === null ? Target : this.Shown + (Target - this.Shown) * Math.min(1, Elapsed * 5);
      const Text = String(Math.round(this.Shown));
      setText(this.Value, Text);
      setText(this.TopValue, Text);
      if (Now - this.LastAnnounced > 15000) {
        this.LastAnnounced = Now;
        setText(this.Live, `Heart rate ${Text} beats per minute`);
      }
    } else if (Snapshot.Phase !== 'Measuring') {
      this.Shown = null;
      setText(this.Value, '--');
      setText(this.TopValue, '--');
    }

    const Stats = Snapshot.SessionStats;
    setText(this.Min, formatNumber(Stats?.Min));
    setText(this.Avg, formatNumber(Stats?.Average));
    setText(this.Max, formatNumber(Stats?.Max));
    this.TrendTag.hidden = !Snapshot.Trend;
    if (Snapshot.Trend) {
      setText(/** @type {Element} */ (this.TrendTag.querySelector('b')), { steady: 'Steady', rising: 'Rising ↑', falling: 'Falling ↓' }[Snapshot.Trend]);
    }
    setText(
      /** @type {Element} */ (this.ConfidenceTag.querySelector('b')),
      Measuring ? `${Math.round(Snapshot.Confidence * 100)}% confident` : 'Confidence --'
    );
    setData(this.ConfidenceTag, 'level', Measuring ? levelFor(Snapshot.Confidence) : undefined);
    setText(/** @type {Element} */ (this.MethodTag.querySelector('b')), Snapshot.Method);
  }
}

export class StagePanel {
  constructor() {
    this.Stage = byId('stage');
    this.Hint = byId('stage-hint');
    this.HintText = byId('stage-hint-text');
    this.Advice = byId('stage-advice');
    this.Fps = byId('fps-chip');
    /** @type {Record<string, HTMLElement>} */
    this.Chips = {};
    for (const Chip of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#stage-chips [data-check]'))) {
      this.Chips[/** @type {string} */ (Chip.dataset.check)] = Chip;
    }
    /** @type {Record<string, HTMLElement>} */
    this.Rows = {};
    for (const Row of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#region-legend [data-region]'))) {
      this.Rows[/** @type {string} */ (Row.dataset.region)] = Row;
    }
  }

  /**
   * @param {EngineSnapshot} Snapshot
   * @param {SceneState} Scene
   * @param {{ Running: boolean, Demo: boolean, Loading: string | null }} State
   */
  update(Snapshot, Scene, State) {
    const Searching = State.Running && !Scene.Face;
    this.Stage.classList.toggle('searching', Searching && !State.Loading);
    const HintText = State.Loading ?? (!State.Running ? 'Paused' : Searching ? 'Looking for your face…' : '');
    this.Hint.classList.toggle('hidden', !HintText);
    if (HintText) setText(this.HintText, HintText);

    for (const Key of ['Lighting', 'Motion', 'Distance']) {
      const Check = /** @type {import('../Vision/SceneChecks.js').Check} */ (/** @type {any} */ (Scene)[Key]);
      const Chip = this.Chips[Key];
      setData(Chip, 'level', Scene.Face ? Check.Level : undefined);
      setText(/** @type {Element} */ (Chip.querySelector('b')), Check.Label);
    }
    setText(/** @type {Element} */ (this.Fps.querySelector('b')), `${Math.round(Scene.Fps)} fps`);

    for (const Name of RegionOrder) {
      const Row = this.Rows[Name];
      const Quality = Snapshot.RegionQuality[Name];
      const Confidence = Scene.Face && Quality ? Quality.Confidence : 0;
      setData(Row, 'level', Scene.Face && Quality ? levelFor(Confidence) : undefined);
      const Bar = /** @type {HTMLElement} */ (Row.querySelector('.meter b'));
      Bar.style.width = `${Math.round(Confidence * 100)}%`;
      Bar.style.background = Confidence >= 0.6 ? Theme.Signal : Confidence >= 0.25 ? Theme.Amber : Theme.Bad;
      setText(/** @type {Element} */ (Row.querySelector('em')), Scene.Face && Quality ? `${Quality.Snr.toFixed(1)} dB` : '--');
    }

    // One piece of advice: the most urgent problem, if any.
    let Advice = '';
    let AdviceLevel = '';
    if (State.Running && Scene.Face) {
      const Checks = [Scene.Lighting, Scene.Motion, Scene.Distance];
      const Worst = Checks.find((Check) => Check.Level === 'bad') ?? Checks.find((Check) => Check.Level === 'warn');
      if (Worst) {
        Advice = Worst.Hint;
        AdviceLevel = Worst.Level;
      } else if (Snapshot.Phase === 'Measuring' && Snapshot.Confidence < 0.25) {
        Advice = 'Signal is weak. Face a brighter light and relax your face.';
        AdviceLevel = 'warn';
      } else if (Snapshot.Phase === 'Measuring') {
        Advice = State.Demo ? 'Demo: a simulated face with a known heart rate.' : 'Looking good. Stay relaxed and breathe normally.';
      }
    } else if (State.Running && State.Demo) {
      Advice = 'Demo: a simulated face with a known heart rate.';
    }
    setText(this.Advice, Advice);
    this.Advice.className = `stage-advice ${AdviceLevel}`;
  }
}

export class StatsPanel {
  constructor() {
    this.BreathValue = byId('breath-value');
    this.BreathOrb = byId('breath-orb');
    this.BreathFoot = byId('breath-foot');
    this.HrvValue = byId('hrv-value');
    this.HrvFoot = byId('hrv-foot');
    this.Poincare = new PoincarePlot(/** @type {HTMLCanvasElement} */ (byId('poincare-canvas')), false);
    this.QualityValue = byId('quality-value');
    this.QualityBars = byId('quality-bars');
    this.QualityFoot = byId('quality-foot');
    this.IbiValue = byId('ibi-value');
    this.IbiFoot = byId('ibi-foot');
    this.Tachogram = new Tachogram(/** @type {HTMLCanvasElement} */ (byId('tachogram-canvas')));
    this.SessionValue = byId('session-value');
    this.SessionFoot = byId('session-foot');
    this.BreathPhase = 0;
    this.LastFrame = performance.now();
  }

  /** Called every frame: only the cheap animated bits. @param {EngineSnapshot} Snapshot @param {boolean} ReduceMotion */
  animate(Snapshot, ReduceMotion) {
    const Now = performance.now();
    const Elapsed = (Now - this.LastFrame) / 1000;
    this.LastFrame = Now;
    const Breath = Snapshot.Respiration;
    if (Breath && !ReduceMotion) {
      this.BreathPhase += Elapsed * (Breath.Rate / 60) * Math.PI * 2;
      this.BreathOrb.style.setProperty('--breath', (0.78 + 0.22 * Math.sin(this.BreathPhase)).toFixed(3));
    }
    setText(this.SessionValue, formatDuration(Snapshot.SessionSeconds));
  }

  /**
   * Called a few times a second.
   * @param {EngineSnapshot} Snapshot
   * @param {number} FramesAnalyzed
   * @param {number[]} BeatTimes All beats this session.
   */
  update(Snapshot, FramesAnalyzed, BeatTimes) {
    const Breath = Snapshot.Respiration;
    this.BreathOrb.classList.toggle('active', Boolean(Breath));
    if (Breath) {
      setText(this.BreathValue, Breath.Rate.toFixed(0));
      setText(this.BreathFoot, `${Math.round(Breath.Confidence * 100)}% confident · from head motion and skin tone`);
    } else {
      setText(this.BreathValue, '--');
      const Left = Math.max(0, Math.ceil((1 - Snapshot.RespirationProgress) * 20));
      setText(this.BreathFoot, Left > 0 ? `Needs 20 s of steady data (${Left} s left)` : 'Looking for a breathing rhythm…');
    }

    const Hrv = Snapshot.Hrv;
    if (Hrv) {
      setText(this.HrvValue, Hrv.Rmssd.toFixed(0));
      setText(this.HrvFoot, `RMSSD · SDNN ${Hrv.Sdnn.toFixed(0)} ms · ${Hrv.ValidBeats} beats`);
      this.Poincare.render(Hrv.Pairs);
    } else {
      setText(this.HrvValue, '--');
      setText(this.HrvFoot, `Collecting beats · ${Math.round(Snapshot.HrvProgress * 100)}%`);
      this.Poincare.render([]);
    }

    const Measuring = Snapshot.Phase !== 'Searching' && Number.isFinite(Snapshot.Snr);
    const Level = levelFor(Snapshot.Confidence);
    setText(this.QualityValue, Measuring ? Snapshot.Snr.toFixed(1) : '--');
    setData(this.QualityBars, 'level', Measuring ? Level : undefined);
    const Lit = Measuring ? Math.max(1, Math.ceil(Snapshot.Confidence * 5)) : 0;
    this.QualityBars.querySelectorAll('i').forEach((Bar, Index) => Bar.classList.toggle('on', Index < Lit));
    setText(
      this.QualityFoot,
      Measuring ? `${Snapshot.Confidence > 0.85 ? 'Excellent' : qualityWord(Level)} signal · ${Math.round(Snapshot.Confidence * 100)}%` : 'Signal-to-noise ratio'
    );

    const Recent = BeatTimes.slice(-17);
    /** @type {number[]} */
    const Intervals = [];
    for (let Index = 1; Index < Recent.length; Index++) {
      const Interval = (Recent[Index] - Recent[Index - 1]) * 1000;
      if (Interval > 250 && Interval < 1500) Intervals.push(Interval);
    }
    const Last = Intervals[Intervals.length - 1];
    setText(this.IbiValue, Last ? Last.toFixed(0) : '--');
    setText(this.IbiFoot, Last ? `≈ ${(60000 / Last).toFixed(0)} BPM from this one beat` : 'Time between your last two beats');
    this.Tachogram.render(Intervals);

    setText(this.SessionFoot, `${Snapshot.BeatCount.toLocaleString()} beats · ${FramesAnalyzed.toLocaleString()} frames analyzed`);
  }
}

export class LabPanel {
  /** @param {(Name: MethodName) => void} onSelect */
  constructor(onSelect) {
    /** @type {Record<string, HTMLElement>} */
    this.Nodes = {};
    for (const Node of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#pipeline [data-node]'))) {
      this.Nodes[/** @type {string} */ (Node.dataset.node)] = Node;
    }
    this.Swatch = /** @type {HTMLElement} */ (this.Nodes.Color.querySelector('.swatch'));
    this.AgreementValue = byId('agreement-value');
    this.AgreementMeter = byId('agreement-meter');
    this.AgreementText = byId('agreement-text');
    /** @type {Record<string, { Row: HTMLElement, Bpm: HTMLElement, Snr: HTMLElement, Chart: MiniSpectrum }>} */
    this.Rows = {};
    const Container = byId('methods');
    for (const Name of MethodNames) {
      const Method = Methods[Name];
      const Row = document.createElement('button');
      Row.type = 'button';
      Row.className = 'method';
      Row.setAttribute('role', 'radio');
      Row.dataset.method = Name;
      Row.innerHTML = `
        <span class="radio"></span>
        <span class="method-name">${Method.Label}<small>${Method.Year}</small></span>
        <span class="method-bpm"><span>--</span><small>BPM</small></span>
        <span class="method-summary">${Method.Summary}</span>
        <span class="method-chart"><canvas></canvas><span>SNR --</span></span>`;
      Row.addEventListener('click', () => onSelect(Name));
      Container.append(Row);
      this.Rows[Name] = {
        Row,
        Bpm: /** @type {HTMLElement} */ (Row.querySelector('.method-bpm span')),
        Snr: /** @type {HTMLElement} */ (Row.querySelector('.method-chart span')),
        Chart: new MiniSpectrum(/** @type {HTMLCanvasElement} */ (Row.querySelector('canvas'))),
      };
    }
  }

  /** @param {MethodName} Selected */
  select(Selected) {
    for (const [Name, Parts] of Object.entries(this.Rows)) Parts.Row.setAttribute('aria-checked', String(Name === Selected));
    setText(/** @type {Element} */ (this.Nodes.Method.querySelector('b')), Methods[Selected].Label);
    setText(/** @type {Element} */ (this.Nodes.Method.querySelector('span')), Selected === 'Green' ? 'green channel' : '1.6 s windows');
  }

  /**
   * @param {EngineSnapshot} Snapshot
   * @param {{ Camera: string, FaceMs: number | null, DetectEvery: number, Face: boolean, Pixels: number, WindowSeconds: number }} Live
   */
  update(Snapshot, Live) {
    /** @param {string} Key @param {string} Text */
    const node = (Key, Text) => {
      const Node = this.Nodes[Key];
      const Span = /** @type {Element} */ (Node.querySelector('span'));
      if (Span.textContent !== Text) {
        Span.textContent = Text;
        restartAnimation(Node, 'ping');
      }
    };
    node('Camera', Live.Camera);
    const Every = Live.DetectEvery > 1 ? ` · 1 in ${Live.DetectEvery}` : '';
    node('Face', !Live.Face ? 'searching…' : Live.FaceMs === null ? '478 pts · simulated' : `478 pts · ${Live.FaceMs.toFixed(0)} ms${Every}`);
    node('Zones', Live.Face ? `${Live.Pixels.toLocaleString()} px` : '--');
    const Color = Snapshot.LatestColor;
    node('Color', Color && Live.Face ? `${Color.R.toFixed(0)} ${Color.G.toFixed(0)} ${Color.B.toFixed(0)}` : '--');
    this.Swatch.style.background = Color ? `rgb(${Color.R}, ${Color.G}, ${Color.B})` : 'transparent';
    const Selected = Snapshot.MethodResults[Snapshot.Method];
    node('Fft', Selected ? `${Live.WindowSeconds} s · ${(Selected.Bpm / 60).toFixed(2)} Hz` : `${Live.WindowSeconds} s window`);
    node('Result', Snapshot.Bpm !== null ? `${Snapshot.Bpm.toFixed(0)} BPM` : '--');

    const Colors = { POS: Theme.Signal, CHROM: Theme.Info, Green: Theme.ChannelG };
    let Rated = 0;
    for (const Name of MethodNames) {
      const Result = Snapshot.MethodResults[Name];
      const Parts = this.Rows[Name];
      setText(Parts.Bpm, Result && Snapshot.Phase !== 'Searching' ? Result.Bpm.toFixed(0) : '--');
      setText(Parts.Snr, Result ? `SNR ${Result.Snr.toFixed(1)} dB` : 'SNR --');
      Parts.Chart.render(Result, Colors[Name]);
      if (Result && Result.Confidence > 0) Rated++;
    }
    const Rates = MethodNames.map((Name) => Snapshot.MethodResults[Name]?.Bpm).filter((Rate) => Rate !== undefined);
    if (Rated >= 2 && Snapshot.Phase !== 'Searching') {
      const Spread = Math.max(...Rates) - Math.min(...Rates);
      setText(this.AgreementValue, `within ${Spread.toFixed(1)} BPM`);
      this.AgreementMeter.style.width = `${Math.round(Snapshot.Agreement * 100)}%`;
      this.AgreementMeter.style.background = Snapshot.Agreement >= 0.6 ? Theme.Signal : Snapshot.Agreement >= 0.25 ? Theme.Amber : Theme.Bad;
      setText(
        this.AgreementText,
        Snapshot.Agreement >= 0.6
          ? 'All three methods land on the same number. That is a trustworthy reading.'
          : Snapshot.Agreement >= 0.25
            ? 'The methods roughly agree. Holding still usually tightens this up.'
            : 'The methods disagree, which usually means motion or poor light. POS is the most robust of the three.'
      );
    } else {
      setText(this.AgreementValue, '--');
      this.AgreementMeter.style.width = '0%';
    }
  }
}
