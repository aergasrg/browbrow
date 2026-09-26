// Start screen: the animated heartbeat line, loading progress, and errors.

import { Surface, Theme, withAlpha } from './Canvas.js';
import { byId } from './Dom.js';

/** One PQRST heartbeat shape, 0..1 in, amplitude out. @param {number} Phase */
function heartbeatShape(Phase) {
  /** @param {number} Center @param {number} Width @param {number} Height */
  const bump = (Center, Width, Height) => Height * Math.exp(-(((Phase - Center) / Width) ** 2));
  return bump(0.18, 0.035, 0.12) - bump(0.3, 0.012, 0.12) + bump(0.33, 0.014, 1) - bump(0.365, 0.014, 0.28) + bump(0.58, 0.05, 0.22);
}

export class StartScreen {
  constructor() {
    this.Root = byId('start-screen');
    this.Surface = new Surface(/** @type {HTMLCanvasElement} */ (byId('start-ecg')));
    this.Progress = byId('load-progress');
    this.ProgressFill = byId('load-bar-fill');
    this.ProgressLabel = byId('load-label');
    this.Error = byId('start-error');
    this.StartButton = /** @type {HTMLButtonElement} */ (byId('start-button'));
    this.DemoButton = /** @type {HTMLButtonElement} */ (byId('demo-button'));
    this.Running = false;
    this.Frame = 0;
  }

  show() {
    this.Root.hidden = false;
    if (!this.Running) {
      this.Running = true;
      const Started = performance.now();
      const step = () => {
        if (!this.Running) return;
        this.draw((performance.now() - Started) / 1000);
        this.Frame = requestAnimationFrame(step);
      };
      this.Frame = requestAnimationFrame(step);
    }
  }

  hide() {
    this.Root.hidden = true;
    this.Running = false;
    cancelAnimationFrame(this.Frame);
  }

  /** @param {number} Time */
  draw(Time) {
    const { Context, Width, Height } = this.Surface.begin();
    const Reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const BeatWidth = Math.max(220, Width / 3.2);
    const Speed = Reduced ? 0 : 90;
    const Baseline = Height * 0.93;
    const Amplitude = Math.min(120, Height * 0.14);
    const Head = (Time * Speed) % (Width + BeatWidth);
    Context.lineWidth = 2;
    Context.lineJoin = 'round';
    for (const [Offset, Alpha] of [
      [0, 0.9],
      [Height * 0.1, 0.25],
    ]) {
      Context.beginPath();
      for (let X = 0; X <= Width; X += 2) {
        const Phase = (((X + Time * Speed * 0.35) % BeatWidth) + BeatWidth) % BeatWidth / BeatWidth;
        const Y = Baseline - Offset - heartbeatShape(Phase) * Amplitude * (Offset ? 0.5 : 1);
        if (X === 0) Context.moveTo(X, Y);
        else Context.lineTo(X, Y);
      }
      const Gradient = Context.createLinearGradient(0, 0, Width, 0);
      const Focus = Math.min(1, Math.max(0, Head / Width));
      Gradient.addColorStop(0, withAlpha(Theme.Pulse, 0.05 * Alpha));
      Gradient.addColorStop(Math.max(0, Focus - 0.25), withAlpha(Theme.Pulse, 0.25 * Alpha));
      Gradient.addColorStop(Focus, withAlpha(Theme.Pulse, Alpha));
      Gradient.addColorStop(Math.min(1, Focus + 0.02), withAlpha(Theme.Pulse, 0.08 * Alpha));
      Gradient.addColorStop(1, withAlpha(Theme.Pulse, 0.05 * Alpha));
      Context.strokeStyle = Gradient;
      Context.stroke();
    }
  }

  /** @param {string | null} Label @param {number} [Fraction] */
  setProgress(Label, Fraction = 0) {
    this.Progress.hidden = Label === null;
    if (Label !== null) {
      this.ProgressLabel.textContent = Label;
      this.ProgressFill.style.width = `${Math.round(Fraction * 100)}%`;
    }
    this.StartButton.disabled = Label !== null;
    this.DemoButton.disabled = Label !== null;
  }

  /** @param {string | null} Html Trusted markup built by the app, or null to hide. */
  setError(Html) {
    this.Error.hidden = Html === null;
    this.Error.innerHTML = Html ?? '';
  }
}
