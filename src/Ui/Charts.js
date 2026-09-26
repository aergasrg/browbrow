// Canvas charts: the sweeping pulse monitor, the frequency spectrum, the
// session trend, the Poincaré plot, the beat-interval tachogram, and the
// small per-method spectra.

import { MaxBpm, MinBpm } from '../Config.js';
import { Surface, Theme, drawPill, withAlpha } from './Canvas.js';
import { formatDuration } from './Dom.js';

/** @typedef {import('../Signal/PulseEngine.js').EngineSnapshot} EngineSnapshot */
/** @typedef {import('../Signal/PulseEngine.js').EstimateLogEntry} EstimateLogEntry */

/**
 * Round tick step for a span.
 * @param {number} Span
 * @param {number} Count Roughly how many ticks.
 */
function niceStep(Span, Count) {
  const Raw = Span / Math.max(1, Count);
  const Power = Math.pow(10, Math.floor(Math.log10(Raw)));
  const Fraction = Raw / Power;
  const Nice = Fraction < 1.5 ? 1 : Fraction < 3.5 ? 2 : Fraction < 7.5 ? 5 : 10;
  return Nice * Power;
}

/** @param {CanvasRenderingContext2D} Context @param {string} Text @param {number} Width @param {number} Height */
function drawEmpty(Context, Text, Width, Height) {
  Context.fillStyle = Theme.Muted;
  Context.font = `500 12px ${Theme.Font}`;
  Context.textAlign = 'center';
  Context.textBaseline = 'middle';
  Context.fillText(Text, Width / 2, Height / 2);
}

/** Hospital-monitor style sweep: new signal is written at a moving cursor. */
export class WaveChart {
  /** @param {HTMLCanvasElement} Canvas */
  constructor(Canvas) {
    this.Surface = new Surface(Canvas);
    this.SweepSeconds = 6;
  }

  /**
   * @param {object} Input
   * @param {EngineSnapshot['Wave']} Input.Wave
   * @param {EngineSnapshot['RawWave']} Input.RawWave
   * @param {number[]} Input.Beats
   * @param {number} Input.SessionStart
   * @param {boolean} Input.ShowRaw
   */
  render({ Wave, RawWave, Beats, SessionStart, ShowRaw }) {
    const { Context, Width, Height } = this.Surface.begin();
    this.drawGrid(Context, Width, Height);
    if (!Wave || Wave.Values.length < 2) {
      Context.strokeStyle = withAlpha(Theme.Signal, 0.25);
      Context.lineWidth = 1.5;
      Context.beginPath();
      Context.moveTo(0, Height / 2);
      Context.lineTo(Width, Height / 2);
      Context.stroke();
      drawEmpty(Context, 'Waiting for a steady signal…', Width, Height * 0.3);
      return;
    }
    const Sweep = this.SweepSeconds;
    const Rate = Wave.Rate;
    const Count = Wave.Values.length;
    const CursorTime = Wave.StartTime + (Count - 1) / Rate;
    const Visible = Sweep * 0.94; // The rest of the sweep is the erase gap ahead of the cursor.
    const First = Math.max(0, Math.ceil((CursorTime - Visible - Wave.StartTime) * Rate));
    /** @param {number} Time */
    const xAt = (Time) => ((((Time - SessionStart) % Sweep) + Sweep) % Sweep) / Sweep * Width;

    /**
     * @param {ArrayLike<number>} Values
     * @param {(Value: number) => number} yAt
     * @param {string} Color
     * @param {number} LineWidth
     */
    const trace = (Values, yAt, Color, LineWidth) => {
      Context.strokeStyle = Color;
      Context.lineWidth = LineWidth;
      Context.lineJoin = 'round';
      Context.beginPath();
      let PreviousX = -1;
      for (let Index = First; Index < Count; Index++) {
        const X = xAt(Wave.StartTime + Index / Rate);
        const Y = yAt(Values[Index]);
        if (X < PreviousX || PreviousX < 0) Context.moveTo(X, Y);
        else Context.lineTo(X, Y);
        PreviousX = X;
      }
      Context.stroke();
    };

    const CursorX = xAt(CursorTime);
    if (ShowRaw && RawWave) {
      let Largest = 0.12;
      for (const Channel of [RawWave.R, RawWave.G, RawWave.B]) {
        for (let Index = First; Index < Channel.length; Index++) Largest = Math.max(Largest, Math.abs(Channel[Index]));
      }
      const Range = Largest * 1.15;
      /** @param {number} Value */
      const yAt = (Value) => Height / 2 - (Value / Range) * (Height * 0.42);
      trace(RawWave.B, yAt, withAlpha(Theme.ChannelB, 0.9), 1.4);
      trace(RawWave.R, yAt, withAlpha(Theme.ChannelR, 0.9), 1.4);
      trace(RawWave.G, yAt, Theme.ChannelG, 1.8);
      Context.fillStyle = Theme.Muted;
      Context.font = `500 10px ${Theme.Mono}`;
      Context.textAlign = 'left';
      Context.textBaseline = 'top';
      Context.fillText(`±${Range.toFixed(2)}% color change`, 8, 8);
    } else {
      /** @param {number} Value */
      const yAt = (Value) => Math.max(4, Math.min(Height - 4, Height / 2 - Value * Height * 0.17));
      trace(Wave.Values, yAt, withAlpha(Theme.Signal, 0.16), 6);
      trace(Wave.Values, yAt, Theme.Signal, 1.9);
      // Beat markers.
      for (const Beat of Beats) {
        if (Beat < CursorTime - Visible) continue;
        const Position = (Beat - Wave.StartTime) * Rate;
        const Low = Math.floor(Position);
        if (Low < 0 || Low >= Count - 1) continue;
        const Value = Wave.Values[Low] + (Position - Low) * (Wave.Values[Low + 1] - Wave.Values[Low]);
        const X = xAt(Beat);
        const Y = yAt(Value);
        Context.fillStyle = withAlpha(Theme.Pulse, 0.25);
        Context.beginPath();
        Context.arc(X, Y, 7, 0, Math.PI * 2);
        Context.fill();
        Context.fillStyle = Theme.Pulse;
        Context.beginPath();
        Context.arc(X, Y, 3.2, 0, Math.PI * 2);
        Context.fill();
        Context.fillStyle = withAlpha(Theme.Pulse, 0.7);
        Context.beginPath();
        Context.moveTo(X - 4, 6);
        Context.lineTo(X + 4, 6);
        Context.lineTo(X, 11);
        Context.closePath();
        Context.fill();
      }
      const LastY = yAt(Wave.Values[Count - 1]);
      Context.fillStyle = withAlpha(Theme.Signal, 0.3);
      Context.beginPath();
      Context.arc(CursorX, LastY, 8, 0, Math.PI * 2);
      Context.fill();
      Context.fillStyle = '#d9fff0';
      Context.beginPath();
      Context.arc(CursorX, LastY, 3, 0, Math.PI * 2);
      Context.fill();
    }
    // Erase gap and cursor line.
    const Gap = (1 - Visible / Sweep) * Width;
    const Fade = Context.createLinearGradient(CursorX, 0, CursorX + Gap, 0);
    Fade.addColorStop(0, withAlpha(Theme.Signal, 0.14));
    Fade.addColorStop(1, withAlpha(Theme.Signal, 0));
    Context.fillStyle = Fade;
    Context.fillRect(CursorX + 1, 0, Gap, Height);
    Context.fillStyle = Theme.Muted;
    Context.font = `500 10px ${Theme.Mono}`;
    Context.textAlign = 'right';
    Context.textBaseline = 'bottom';
    Context.fillText(`${Sweep} s sweep`, Width - 8, Height - 6);
  }

  /** @param {CanvasRenderingContext2D} Context @param {number} Width @param {number} Height */
  drawGrid(Context, Width, Height) {
    const Steps = this.SweepSeconds * 5;
    for (let Step = 0; Step <= Steps; Step++) {
      const X = Math.round((Step / Steps) * Width) + 0.5;
      Context.strokeStyle = Step % 5 === 0 ? 'rgba(61, 220, 151, 0.1)' : 'rgba(61, 220, 151, 0.04)';
      Context.lineWidth = 1;
      Context.beginPath();
      Context.moveTo(X, 0);
      Context.lineTo(X, Height);
      Context.stroke();
    }
    const Rows = 6;
    for (let Row = 0; Row <= Rows; Row++) {
      const Y = Math.round((Row / Rows) * Height) + 0.5;
      Context.strokeStyle = Row === Rows / 2 ? 'rgba(61, 220, 151, 0.12)' : 'rgba(61, 220, 151, 0.04)';
      Context.beginPath();
      Context.moveTo(0, Y);
      Context.lineTo(Width, Y);
      Context.stroke();
    }
  }
}

/** Amplitude spectrum with the winning peak and the "signal" bands. */
export class SpectrumChart {
  /** @param {HTMLCanvasElement} Canvas */
  constructor(Canvas) {
    this.Surface = new Surface(Canvas);
  }

  /**
   * @param {object} Input
   * @param {import('../Signal/PulseEngine.js').MethodResult | null} Input.Result
   */
  render({ Result }) {
    const { Context, Width, Height } = this.Surface.begin();
    const Left = 8;
    const Right = Width - 16;
    const Top = 26;
    const Bottom = Height - 20;
    /** @param {number} Bpm */
    const xAt = (Bpm) => Left + ((Bpm - MinBpm) / (MaxBpm - MinBpm)) * (Right - Left);
    Context.font = `500 10px ${Theme.Mono}`;
    Context.textAlign = 'center';
    Context.textBaseline = 'top';
    for (let Bpm = 60; Bpm <= 240; Bpm += 30) {
      const X = Math.round(xAt(Bpm)) + 0.5;
      Context.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      Context.beginPath();
      Context.moveTo(X, Top - 6);
      Context.lineTo(X, Bottom);
      Context.stroke();
      Context.fillStyle = Theme.Muted;
      Context.fillText(String(Bpm), X, Bottom + 5);
    }
    Context.strokeStyle = Theme.Line2;
    Context.beginPath();
    Context.moveTo(Left, Bottom + 0.5);
    Context.lineTo(Right, Bottom + 0.5);
    Context.stroke();
    if (!Result || !Result.Bpms.length) {
      drawEmpty(Context, 'Collecting a few seconds of signal…', Width, (Top + Bottom) / 2);
      return;
    }
    const Peak = Result.Bpm;
    // Signal bands: the peak and its harmonic count as signal for the SNR.
    Context.fillStyle = withAlpha(Theme.Pulse, 0.12);
    Context.fillRect(xAt(Peak - 9), Top - 6, xAt(Peak + 9) - xAt(Peak - 9), Bottom - Top + 6);
    if (2 * Peak < MaxBpm) {
      Context.fillStyle = withAlpha(Theme.Pulse, 0.06);
      Context.fillRect(xAt(2 * Peak - 13.5), Top - 6, xAt(2 * Peak + 13.5) - xAt(2 * Peak - 13.5), Bottom - Top + 6);
      Context.fillStyle = withAlpha(Theme.Pulse, 0.7);
      Context.fillText('2×', xAt(2 * Peak), Top - 4);
    }
    const Amplitudes = Array.from(Result.Power, (Value) => Math.sqrt(Value));
    /** @param {number} Value */
    const yAt = (Value) => Bottom - Value * (Bottom - Top);
    Context.beginPath();
    Context.moveTo(xAt(Result.Bpms[0]), Bottom);
    Result.Bpms.forEach((Bpm, Index) => Context.lineTo(xAt(Bpm), yAt(Amplitudes[Index])));
    Context.lineTo(xAt(Result.Bpms[Result.Bpms.length - 1]), Bottom);
    Context.closePath();
    const Fill = Context.createLinearGradient(0, Top, 0, Bottom);
    Fill.addColorStop(0, withAlpha(Theme.Signal, 0.4));
    Fill.addColorStop(1, withAlpha(Theme.Signal, 0.02));
    Context.fillStyle = Fill;
    Context.fill();
    Context.beginPath();
    Result.Bpms.forEach((Bpm, Index) => (Index ? Context.lineTo(xAt(Bpm), yAt(Amplitudes[Index])) : Context.moveTo(xAt(Bpm), yAt(Amplitudes[Index]))));
    Context.strokeStyle = Theme.Signal;
    Context.lineWidth = 1.6;
    Context.stroke();
    // Peak marker.
    const PeakX = xAt(Peak);
    let PeakIndex = 0;
    Result.Bpms.forEach((Bpm, Index) => {
      if (Math.abs(Bpm - Peak) < Math.abs(Result.Bpms[PeakIndex] - Peak)) PeakIndex = Index;
    });
    const PeakY = yAt(Amplitudes[PeakIndex]);
    Context.setLineDash([3, 3]);
    Context.strokeStyle = withAlpha(Theme.Pulse, 0.8);
    Context.beginPath();
    Context.moveTo(PeakX, PeakY);
    Context.lineTo(PeakX, Bottom);
    Context.stroke();
    Context.setLineDash([]);
    Context.fillStyle = Theme.Pulse;
    Context.beginPath();
    Context.arc(PeakX, PeakY, 4, 0, Math.PI * 2);
    Context.fill();
    const LabelX = Math.max(Left + 34, Math.min(Right - 34, PeakX));
    drawPill(Context, `${Peak.toFixed(1)} BPM`, LabelX, Math.max(11, PeakY - 14), {
      Color: '#fff',
      Background: withAlpha(Theme.Pulse, 0.9),
      Size: 10.5,
    });
  }
}

/** Heart rate over the whole session, brighter where confidence was higher. */
export class TrendChart {
  /** @param {HTMLCanvasElement} Canvas */
  constructor(Canvas) {
    this.Surface = new Surface(Canvas);
  }

  /**
   * @param {object} Input
   * @param {EstimateLogEntry[]} Input.Log
   * @param {number} Input.SessionStart
   * @param {number} Input.Now
   */
  render({ Log, SessionStart, Now }) {
    const { Context, Width, Height } = this.Surface.begin();
    const Points = Log.filter((Entry) => Entry.Bpm !== null);
    const Left = 34;
    const Right = Width - 14;
    const Top = 12;
    const Bottom = Height - 24;
    if (Points.length < 2) {
      drawEmpty(Context, 'Your heart rate over the session appears here', Width, Height / 2);
      return;
    }
    const Elapsed = Math.max(60, Now - SessionStart);
    let Low = Infinity;
    let High = -Infinity;
    let Sum = 0;
    for (const Entry of Points) {
      const Bpm = /** @type {number} */ (Entry.Bpm);
      Low = Math.min(Low, Bpm);
      High = Math.max(High, Bpm);
      Sum += Bpm;
    }
    const Average = Sum / Points.length;
    const Middle = (Low + High) / 2;
    const Span = Math.max(20, High - Low + 10);
    const MinY = Math.floor((Middle - Span / 2) / 5) * 5;
    const MaxY = Math.ceil((Middle + Span / 2) / 5) * 5;
    /** @param {number} Time */
    const xAt = (Time) => Left + ((Time - SessionStart) / Elapsed) * (Right - Left);
    /** @param {number} Bpm */
    const yAt = (Bpm) => Bottom - ((Bpm - MinY) / (MaxY - MinY)) * (Bottom - Top);

    Context.font = `500 10px ${Theme.Mono}`;
    const StepY = niceStep(MaxY - MinY, 4);
    Context.textAlign = 'right';
    Context.textBaseline = 'middle';
    for (let Value = Math.ceil(MinY / StepY) * StepY; Value <= MaxY; Value += StepY) {
      const Y = Math.round(yAt(Value)) + 0.5;
      Context.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      Context.beginPath();
      Context.moveTo(Left, Y);
      Context.lineTo(Right, Y);
      Context.stroke();
      if (Y > Bottom - 6) continue; // Leave the corner to the time axis.
      Context.fillStyle = Theme.Muted;
      Context.fillText(String(Value), Left - 6, Y);
    }
    const StepX = [15, 30, 60, 120, 300, 600, 900, 1800].find((Step) => Elapsed / Step <= 6) ?? 3600;
    Context.textAlign = 'center';
    Context.textBaseline = 'top';
    for (let Time = 0; Time <= Elapsed; Time += StepX) {
      const X = xAt(SessionStart + Time);
      Context.fillStyle = Theme.Muted;
      Context.textAlign = Time === 0 ? 'left' : X > Right - 20 ? 'right' : 'center';
      Context.fillText(formatDuration(Time), Time === 0 ? Left : X, Bottom + 6);
    }
    // Average line.
    Context.setLineDash([4, 4]);
    Context.strokeStyle = withAlpha(Theme.Info, 0.6);
    Context.beginPath();
    Context.moveTo(Left, yAt(Average));
    Context.lineTo(Right, yAt(Average));
    Context.stroke();
    Context.setLineDash([]);
    Context.fillStyle = Theme.Info;
    Context.textAlign = 'right';
    Context.textBaseline = 'bottom';
    Context.fillText(`avg ${Average.toFixed(0)}`, Right, yAt(Average) - 3);
    // Line, segment by segment so confidence can set the brightness.
    Context.lineWidth = 2;
    Context.lineCap = 'round';
    for (let Index = 1; Index < Points.length; Index++) {
      const Previous = Points[Index - 1];
      const Current = Points[Index];
      if (Current.Time - Previous.Time > 3) continue; // Face was lost; leave a gap.
      Context.strokeStyle = withAlpha(Theme.Pulse, 0.2 + 0.8 * Current.Confidence);
      Context.beginPath();
      Context.moveTo(xAt(Previous.Time), yAt(/** @type {number} */ (Previous.Bpm)));
      Context.lineTo(xAt(Current.Time), yAt(/** @type {number} */ (Current.Bpm)));
      Context.stroke();
    }
    const Last = Points[Points.length - 1];
    Context.fillStyle = withAlpha(Theme.Pulse, 0.3);
    Context.beginPath();
    Context.arc(xAt(Last.Time), yAt(/** @type {number} */ (Last.Bpm)), 7, 0, Math.PI * 2);
    Context.fill();
    Context.fillStyle = Theme.Pulse;
    Context.beginPath();
    Context.arc(xAt(Last.Time), yAt(/** @type {number} */ (Last.Bpm)), 3, 0, Math.PI * 2);
    Context.fill();
  }
}

/** Each beat interval against the next. */
export class PoincarePlot {
  /** @param {HTMLCanvasElement} Canvas @param {boolean} Large */
  constructor(Canvas, Large) {
    this.Surface = new Surface(Canvas);
    this.Large = Large;
  }

  /** @param {[number, number][]} Pairs Milliseconds. */
  render(Pairs) {
    const { Context, Width, Height } = this.Surface.begin();
    const Padding = this.Large ? 36 : 4;
    const Size = Math.min(Width, Height) - Padding * 1.5;
    const Left = this.Large ? (Width - Size) / 2 + Padding / 2 : (Width - Size) / 2;
    const Top = (Height - Size) / 2 - (this.Large ? Padding / 4 : 0);
    Context.strokeStyle = Theme.Line2;
    Context.lineWidth = 1;
    Context.strokeRect(Left + 0.5, Top + 0.5, Size, Size);
    if (Pairs.length < 3) {
      if (this.Large) drawEmpty(Context, 'Needs about 30 clean beats', Width, Height / 2);
      return;
    }
    const All = Pairs.flat();
    const Low = Math.min(...All) - 40;
    const High = Math.max(...All) + 40;
    /** @param {number} Value */
    const scale = (Value) => ((Value - Low) / (High - Low)) * Size;
    Context.setLineDash([3, 3]);
    Context.strokeStyle = withAlpha(Theme.Muted, 0.6);
    Context.beginPath();
    Context.moveTo(Left, Top + Size);
    Context.lineTo(Left + Size, Top);
    Context.stroke();
    Context.setLineDash([]);
    if (this.Large) {
      // SD1 / SD2 ellipse: short-term variability across the identity line, long-term along it.
      const Across = Pairs.map(([A, B]) => (B - A) / Math.SQRT2);
      const Along = Pairs.map(([A, B]) => (B + A) / Math.SQRT2);
      /** @param {number[]} Values */
      const spread = (Values) => {
        const Mean = Values.reduce((Sum, Value) => Sum + Value, 0) / Values.length;
        return Math.sqrt(Values.reduce((Sum, Value) => Sum + (Value - Mean) ** 2, 0) / Values.length);
      };
      const Sd1 = spread(Across);
      const Sd2 = spread(Along);
      const MeanInterval = All.reduce((Sum, Value) => Sum + Value, 0) / All.length;
      const CenterX = Left + scale(MeanInterval);
      const CenterY = Top + Size - scale(MeanInterval);
      const PixelsPerMs = Size / (High - Low);
      Context.save();
      Context.translate(CenterX, CenterY);
      Context.rotate(-Math.PI / 4);
      Context.beginPath();
      Context.ellipse(0, 0, Math.max(2, Sd2 * PixelsPerMs), Math.max(2, Sd1 * PixelsPerMs), 0, 0, Math.PI * 2);
      Context.fillStyle = withAlpha(Theme.Info, 0.08);
      Context.fill();
      Context.strokeStyle = withAlpha(Theme.Info, 0.7);
      Context.stroke();
      Context.restore();
      Context.fillStyle = Theme.Muted;
      Context.font = `500 10px ${Theme.Mono}`;
      Context.textAlign = 'center';
      Context.textBaseline = 'top';
      Context.fillText(`interval n (ms) · SD1 ${Sd1.toFixed(0)} · SD2 ${Sd2.toFixed(0)}`, Left + Size / 2, Top + Size + 8);
      Context.save();
      Context.translate(Left - 10, Top + Size / 2);
      Context.rotate(-Math.PI / 2);
      Context.textBaseline = 'bottom';
      Context.fillText('interval n+1 (ms)', 0, 0);
      Context.restore();
    }
    Context.fillStyle = withAlpha(Theme.Pulse, this.Large ? 0.75 : 0.8);
    const Radius = this.Large ? 3 : 1.6;
    for (const [A, B] of Pairs) {
      Context.beginPath();
      Context.arc(Left + scale(A), Top + Size - scale(B), Radius, 0, Math.PI * 2);
      Context.fill();
    }
  }
}

/** Recent beat intervals as bars. */
export class Tachogram {
  /** @param {HTMLCanvasElement} Canvas */
  constructor(Canvas) {
    this.Surface = new Surface(Canvas);
  }

  /** @param {number[]} Intervals Milliseconds, oldest first. */
  render(Intervals) {
    const { Context, Width, Height } = this.Surface.begin();
    const Recent = Intervals.slice(-16);
    if (Recent.length < 2) return;
    const Low = Math.min(...Recent) - 40;
    const High = Math.max(...Recent) + 20;
    const Gap = 2;
    const BarWidth = (Width - Gap * (Recent.length - 1)) / Recent.length;
    Recent.forEach((Interval, Index) => {
      const BarHeight = Math.max(3, ((Interval - Low) / (High - Low)) * Height);
      Context.fillStyle = withAlpha(Theme.Pulse, Index === Recent.length - 1 ? 1 : 0.35 + (0.4 * Index) / Recent.length);
      Context.beginPath();
      Context.roundRect(Index * (BarWidth + Gap), Height - BarHeight, BarWidth, BarHeight, 2);
      Context.fill();
    });
  }
}

/** Small spectrum for the Algorithm Lab rows. */
export class MiniSpectrum {
  /** @param {HTMLCanvasElement} Canvas */
  constructor(Canvas) {
    this.Surface = new Surface(Canvas);
  }

  /** @param {import('../Signal/PulseEngine.js').MethodResult | null} Result @param {string} Color */
  render(Result, Color) {
    const { Context, Width, Height } = this.Surface.begin();
    Context.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    Context.beginPath();
    Context.moveTo(0, Height - 0.5);
    Context.lineTo(Width, Height - 0.5);
    Context.stroke();
    if (!Result || !Result.Bpms.length) return;
    /** @param {number} Bpm */
    const xAt = (Bpm) => ((Bpm - MinBpm) / (MaxBpm - MinBpm)) * Width;
    Context.beginPath();
    Result.Bpms.forEach((Bpm, Index) => {
      const Y = Height - 2 - Math.sqrt(Result.Power[Index]) * (Height - 5);
      if (Index) Context.lineTo(xAt(Bpm), Y);
      else Context.moveTo(xAt(Bpm), Y);
    });
    Context.strokeStyle = Color;
    Context.lineWidth = 1.3;
    Context.stroke();
    Context.fillStyle = Theme.Pulse;
    Context.beginPath();
    Context.arc(xAt(Result.Bpm), 4, 2.5, 0, Math.PI * 2);
    Context.fill();
  }
}
