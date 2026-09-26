// Dialogs: accuracy check (tap along with your pulse), session summary,
// HRV detail, and settings.

import { CameraSource } from '../Camera/CameraSource.js';
import { downloadText, stamp, toCsv } from '../Export/Csv.js';
import { median } from '../Signal/Stats.js';
import { PoincarePlot, TrendChart } from './Charts.js';
import { byId, formatDuration, formatNumber, restartAnimation, setData, setText } from './Dom.js';

/** @typedef {import('../Signal/PulseEngine.js').PulseEngine} PulseEngine */
/** @typedef {import('../Signal/PulseEngine.js').EngineSnapshot} EngineSnapshot */
/** @typedef {import('../Settings.js').Settings} Settings */

/** Opens a <dialog> as a modal with close buttons and backdrop-click to close. */
class Modal {
  /** @param {string} Id */
  constructor(Id) {
    this.Dialog = /** @type {HTMLDialogElement} */ (byId(Id));
    this.Dialog.querySelectorAll('[data-close]').forEach((Button) => Button.addEventListener('click', () => this.close()));
    this.Dialog.addEventListener('click', (Event) => {
      if (Event.target === this.Dialog) this.close();
    });
    this.Dialog.addEventListener('close', () => this.onClose());
  }

  open() {
    if (!this.Dialog.open) this.Dialog.showModal();
  }

  close() {
    if (this.Dialog.open) this.Dialog.close();
  }

  get isOpen() {
    return this.Dialog.open;
  }

  onClose() {}
}

/**
 * @typedef {object} VerifyResult
 * @property {number} TapBpm
 * @property {number} CameraBpm
 * @property {number} Taps
 */

export class VerifyDialog extends Modal {
  /** @param {(Result: VerifyResult) => void} onResult */
  constructor(onResult) {
    super('verify-dialog');
    this.onResult = onResult;
    this.Pad = byId('tap-pad');
    this.Label = byId('tap-label');
    this.Taps = byId('verify-taps');
    this.Camera = byId('verify-camera');
    this.Diff = byId('verify-diff');
    this.Verdict = byId('verify-verdict');
    /** @type {number[]} */
    this.TapTimes = [];
    this.CameraBpm = /** @type {number | null} */ (null);
    // Event.timeStamp is when the finger actually landed, even if the page was busy.
    this.Pad.addEventListener('pointerdown', (Event) => {
      Event.preventDefault();
      this.tap(Event.timeStamp);
    });
    this.Pad.addEventListener('keydown', (Event) => {
      if (Event.key === 'Enter') {
        Event.preventDefault();
        this.tap(Event.timeStamp);
      }
    });
    document.addEventListener('keydown', (Event) => {
      if (this.isOpen && Event.code === 'Space' && !Event.repeat) {
        Event.preventDefault();
        this.tap(Event.timeStamp);
      }
    });
    byId('verify-reset').addEventListener('click', () => this.reset());
  }

  open() {
    this.reset();
    super.open();
  }

  reset() {
    this.TapTimes = [];
    setText(this.Label, 'Tap with each beat');
    setText(this.Taps, '--');
    setText(this.Diff, '--');
    setData(this.Verdict, 'level', undefined);
    setText(this.Verdict, 'Tap at least 8 beats for a reading. On a laptop, the space bar works too.');
  }

  /** @param {number} TimeStamp Milliseconds on the performance.now() clock. */
  tap(TimeStamp) {
    const Now = TimeStamp / 1000;
    const Previous = this.TapTimes[this.TapTimes.length - 1];
    if (Previous !== undefined && Now - Previous > 2.5) this.TapTimes = []; // Long pause: start over.
    this.TapTimes.push(Now);
    restartAnimation(this.Pad, 'tapped');
    setTimeout(() => this.Pad.classList.remove('tapped'), 120);
    setText(this.Label, `${this.TapTimes.length} tap${this.TapTimes.length === 1 ? '' : 's'}`);
    this.refresh();
  }

  /** Called while open with the current camera reading. @param {number | null} Bpm */
  setCamera(Bpm) {
    this.CameraBpm = Bpm;
    setText(this.Camera, formatNumber(Bpm));
    this.refresh();
  }

  refresh() {
    const Recent = this.TapTimes.slice(-11);
    if (Recent.length < 3) return;
    /** @type {number[]} */
    const Intervals = [];
    for (let Index = 1; Index < Recent.length; Index++) Intervals.push(Recent[Index] - Recent[Index - 1]);
    const TapBpm = 60 / median(Intervals);
    setText(this.Taps, TapBpm.toFixed(0));
    if (this.CameraBpm === null) {
      setText(this.Diff, '--');
      setText(this.Verdict, 'The camera has no reading yet. Keep your face in view.');
      return;
    }
    const Difference = Math.abs(TapBpm - this.CameraBpm);
    setText(this.Diff, Difference.toFixed(0));
    if (this.TapTimes.length < 8) {
      setText(this.Verdict, `Keep tapping… ${8 - this.TapTimes.length} more for a reliable comparison.`);
      return;
    }
    const Level = Difference <= 5 ? 'good' : Difference <= 10 ? 'warn' : 'bad';
    setData(this.Verdict, 'level', Level);
    setText(
      this.Verdict,
      Level === 'good'
        ? `Within ${Difference.toFixed(0)} BPM of your real pulse. The camera is nailing it.`
        : Level === 'warn'
          ? `Off by ${Difference.toFixed(0)} BPM. Close; holding still and better light usually help.`
          : `Off by ${Difference.toFixed(0)} BPM. Check the lighting and signal quality, or tap more steadily.`
    );
    this.onResult({ TapBpm, CameraBpm: this.CameraBpm, Taps: this.TapTimes.length });
  }
}

export class SummaryDialog extends Modal {
  /**
   * @param {() => { Engine: PulseEngine, Snapshot: EngineSnapshot, Verify: VerifyResult | null, Demo: boolean }} getState
   * @param {() => void} onNewSession
   */
  constructor(getState, onNewSession) {
    super('summary-dialog');
    this.getState = getState;
    this.Chart = new TrendChart(/** @type {HTMLCanvasElement} */ (byId('summary-canvas')));
    this.Average = byId('summary-avg');
    this.List = byId('summary-list');
    this.Note = byId('summary-note');
    byId('export-estimates').addEventListener('click', () => this.exportEstimates());
    byId('export-raw').addEventListener('click', () => this.exportRaw());
    byId('summary-new').addEventListener('click', () => {
      this.close();
      onNewSession();
    });
  }

  open() {
    super.open();
    this.fill();
    requestAnimationFrame(() => this.fill()); // Once more after layout, for the chart size.
  }

  fill() {
    const { Engine, Snapshot, Verify, Demo } = this.getState();
    const Stats = Snapshot.SessionStats;
    setText(this.Average, formatNumber(Stats?.Average));
    const Confident = Engine.EstimateLog.filter((Entry) => Entry.Bpm !== null);
    const MeanConfidence = Confident.length ? Confident.reduce((Sum, Entry) => Sum + Entry.Confidence, 0) / Confident.length : 0;
    const Breaths = Engine.RespirationLog.filter((Entry) => Entry.Confidence >= 0.3);
    const MeanBreath = Breaths.length ? Breaths.reduce((Sum, Entry) => Sum + Entry.Rate, 0) / Breaths.length : null;
    /** @type {[string, string][]} */
    const Rows = [
      ['Duration', formatDuration(Snapshot.SessionSeconds)],
      ['Range', Stats ? `${Stats.Min.toFixed(0)}–${Stats.Max.toFixed(0)} BPM` : '--'],
      ['Beats counted', Snapshot.BeatCount.toLocaleString()],
      ['Avg signal quality', Confident.length ? `${Math.round(MeanConfidence * 100)}%` : '--'],
      ['Breathing (beta)', MeanBreath ? `${MeanBreath.toFixed(0)} /min` : '--'],
      ['HRV RMSSD (beta)', Snapshot.Hrv ? `${Snapshot.Hrv.Rmssd.toFixed(0)} ms` : '--'],
      ['Algorithm', Snapshot.Method],
      ['Accuracy check', Verify ? `${Math.abs(Verify.TapBpm - Verify.CameraBpm).toFixed(0)} BPM off (${Verify.Taps} taps)` : 'Not done'],
    ];
    this.List.replaceChildren(
      ...Rows.map(([Term, Value]) => {
        const Item = document.createElement('div');
        const Label = document.createElement('dt');
        const Data = document.createElement('dd');
        Label.textContent = Term;
        Data.textContent = Value;
        Item.append(Label, Data);
        return Item;
      })
    );
    this.Chart.render({ Log: Engine.EstimateLog, SessionStart: Snapshot.SessionStart, Now: Snapshot.Now });
    setText(
      this.Note,
      Demo
        ? 'This was the demo: a simulated face whose heart rate drifts around 72 BPM.'
        : 'Exports stay on your device. The raw color CSV has every skin-color sample, so you can try your own algorithms on it.'
    );
  }

  exportEstimates() {
    const { Engine } = this.getState();
    const Start = Engine.SessionStart ?? 0;
    const Csv = toCsv(
      ['time_s', 'bpm_display', 'bpm_raw', 'snr_db', 'confidence', 'bpm_pos', 'bpm_chrom', 'bpm_green'],
      Engine.EstimateLog.map((Entry) => [
        Entry.Time - Start,
        Entry.Bpm,
        Entry.RawBpm,
        Entry.Snr,
        Entry.Confidence,
        Entry.MethodBpms.POS,
        Entry.MethodBpms.CHROM,
        Entry.MethodBpms.Green,
      ])
    );
    downloadText(`browbrow-pulse-${stamp()}.csv`, Csv);
  }

  exportRaw() {
    const { Engine } = this.getState();
    const { Header, Rows } = Engine.rawExport();
    downloadText(`browbrow-pulse-raw-${stamp()}.csv`, toCsv(Header, Rows));
  }
}

export class HrvDialog extends Modal {
  constructor() {
    super('hrv-dialog');
    this.Plot = new PoincarePlot(/** @type {HTMLCanvasElement} */ (byId('poincare-large')), true);
    this.Rmssd = byId('hrv-rmssd');
    this.Sdnn = byId('hrv-sdnn');
    this.Mean = byId('hrv-mean');
  }

  /** @param {EngineSnapshot} Snapshot */
  update(Snapshot) {
    if (!this.isOpen) return;
    const Hrv = Snapshot.Hrv;
    this.Plot.render(Hrv ? Hrv.Pairs : []);
    setText(this.Rmssd, Hrv ? `${Hrv.Rmssd.toFixed(0)} ms` : '--');
    setText(this.Sdnn, Hrv ? `${Hrv.Sdnn.toFixed(0)} ms` : '--');
    setText(this.Mean, Hrv ? `${Hrv.MeanIbi.toFixed(0)} ms` : '--');
  }
}

export class SettingsDialog extends Modal {
  /** @param {Settings} Store @param {{ MagnifyAvailable: boolean }} Capabilities */
  constructor(Store, Capabilities) {
    super('settings-dialog');
    this.Store = Store;
    this.CameraSelect = /** @type {HTMLSelectElement} */ (byId('camera-select'));
    this.Gain = /** @type {HTMLInputElement} */ (byId('gain-range'));
    this.GainOutput = byId('gain-output');
    for (const Group of /** @type {NodeListOf<HTMLElement>} */ (this.Dialog.querySelectorAll('.segmented[data-setting]'))) {
      const Key = /** @type {keyof import('../Settings.js').SettingsValues} */ (Group.dataset.setting);
      Group.querySelectorAll('button').forEach((Button) =>
        Button.addEventListener('click', () => {
          const Raw = /** @type {string} */ (Button.dataset.value);
          Store.set({ [Key]: Key === 'WindowSeconds' ? Number(Raw) : Raw });
        })
      );
    }
    for (const Input of /** @type {NodeListOf<HTMLInputElement>} */ (this.Dialog.querySelectorAll('input[type=checkbox][data-setting]'))) {
      const Key = /** @type {keyof import('../Settings.js').SettingsValues} */ (Input.dataset.setting);
      Input.addEventListener('change', () => Store.set({ [Key]: Input.checked }));
    }
    this.Gain.addEventListener('input', () => Store.set({ MagnifyGain: Number(this.Gain.value) }));
    this.CameraSelect.addEventListener('change', () => Store.set({ CameraId: this.CameraSelect.value }));
    if (!Capabilities.MagnifyAvailable) /** @type {HTMLElement} */ (this.Gain.closest('.setting')).hidden = true;
    Store.subscribe(() => this.sync());
    this.sync();
  }

  async open() {
    super.open();
    this.sync();
    const Cameras = await CameraSource.listCameras();
    const Current = this.Store.Values.CameraId;
    this.CameraSelect.replaceChildren(
      new Option('Front camera (default)', ''),
      ...Cameras.map((Camera) => new Option(Camera.Label, Camera.DeviceId, false, Camera.DeviceId === Current))
    );
    this.CameraSelect.value = Current;
  }

  sync() {
    const Values = this.Store.Values;
    for (const Group of /** @type {NodeListOf<HTMLElement>} */ (this.Dialog.querySelectorAll('.segmented[data-setting]'))) {
      const Current = String(/** @type {any} */ (Values)[/** @type {string} */ (Group.dataset.setting)]);
      Group.querySelectorAll('button').forEach((Button) => Button.setAttribute('aria-checked', String(Button.dataset.value === Current)));
    }
    for (const Input of /** @type {NodeListOf<HTMLInputElement>} */ (this.Dialog.querySelectorAll('input[type=checkbox][data-setting]'))) {
      Input.checked = Boolean(/** @type {any} */ (Values)[/** @type {string} */ (Input.dataset.setting)]);
    }
    this.Gain.value = String(Values.MagnifyGain);
    setText(this.GainOutput, `${Values.MagnifyGain}×`);
  }
}
