// Crisp canvases on high-density screens, plus the colors used for drawing.

/** Colors, read once from the CSS custom properties so CSS stays the single source. */
export const Theme = {
  Background: '#0a1017',
  Panel: '#0c131b',
  Line: '#19252f',
  Line2: '#24343f',
  Text: '#e8eff5',
  Text2: '#a8b7c5',
  Muted: '#6b7e90',
  Pulse: '#ff4d6d',
  Signal: '#3ddc97',
  Amber: '#ffb547',
  Bad: '#ff5c6c',
  Info: '#57b8ff',
  Violet: '#a78bfa',
  ChannelR: '#ff6b6b',
  ChannelG: '#3ddc97',
  ChannelB: '#5aa9ff',
  Mono: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  Font: 'Inter, system-ui, -apple-system, sans-serif',
};

export function loadTheme() {
  const Style = getComputedStyle(document.documentElement);
  /** @param {string} Name @param {string} Fallback */
  const read = (Name, Fallback) => Style.getPropertyValue(Name).trim() || Fallback;
  Object.assign(Theme, {
    Background: read('--bg-2', Theme.Background),
    Panel: read('--panel', Theme.Panel),
    Line: read('--line', Theme.Line),
    Line2: read('--line-2', Theme.Line2),
    Text: read('--text', Theme.Text),
    Text2: read('--text-2', Theme.Text2),
    Muted: read('--muted', Theme.Muted),
    Pulse: read('--pulse', Theme.Pulse),
    Signal: read('--signal', Theme.Signal),
    Amber: read('--amber', Theme.Amber),
    Bad: read('--bad', Theme.Bad),
    Info: read('--info', Theme.Info),
    Violet: read('--violet', Theme.Violet),
    ChannelR: read('--channel-r', Theme.ChannelR),
    ChannelG: read('--channel-g', Theme.ChannelG),
    ChannelB: read('--channel-b', Theme.ChannelB),
  });
}

/** @param {import('./Dom.js').Level | undefined} Level */
export function levelColor(Level) {
  return Level === 'good' ? Theme.Signal : Level === 'warn' ? Theme.Amber : Level === 'bad' ? Theme.Bad : Theme.Muted;
}

/**
 * Hex color with alpha.
 * @param {string} Hex #rrggbb
 * @param {number} Alpha
 */
export function withAlpha(Hex, Alpha) {
  const Value = Hex.replace('#', '');
  if (Value.length !== 6) return Hex;
  const R = parseInt(Value.slice(0, 2), 16);
  const G = parseInt(Value.slice(2, 4), 16);
  const B = parseInt(Value.slice(4, 6), 16);
  return `rgba(${R}, ${G}, ${B}, ${Alpha})`;
}

/** A canvas whose backing store follows its CSS size and the device pixel ratio. */
export class Surface {
  /** @param {HTMLCanvasElement} Canvas */
  constructor(Canvas) {
    this.Canvas = Canvas;
    const Context = Canvas.getContext('2d');
    if (!Context) throw new Error('Canvas 2D is not available');
    this.Context = Context;
    this.Width = 0;
    this.Height = 0;
  }

  /** Resizes if needed, clears, and returns the drawing size in CSS pixels. */
  begin() {
    const Ratio = Math.min(3, window.devicePixelRatio || 1);
    const Width = this.Canvas.clientWidth;
    const Height = this.Canvas.clientHeight;
    const PixelWidth = Math.max(1, Math.round(Width * Ratio));
    const PixelHeight = Math.max(1, Math.round(Height * Ratio));
    if (this.Canvas.width !== PixelWidth || this.Canvas.height !== PixelHeight) {
      this.Canvas.width = PixelWidth;
      this.Canvas.height = PixelHeight;
    }
    this.Width = Width;
    this.Height = Height;
    this.Context.setTransform(Ratio, 0, 0, Ratio, 0, 0);
    this.Context.clearRect(0, 0, Width, Height);
    return { Context: this.Context, Width, Height };
  }

  /** True when the canvas is on screen and has a size worth drawing. */
  visible() {
    return this.Canvas.clientWidth > 0 && this.Canvas.clientHeight > 0 && this.Canvas.offsetParent !== null;
  }
}

/**
 * Draws a rounded "pill" label.
 * @param {CanvasRenderingContext2D} Context
 * @param {string} Text
 * @param {number} X Center x.
 * @param {number} Y Center y.
 * @param {{ Color?: string, Background?: string, Border?: string, Size?: number }} [Options]
 */
export function drawPill(Context, Text, X, Y, Options = {}) {
  const Size = Options.Size ?? 11;
  Context.font = `600 ${Size}px ${Theme.Mono}`;
  const Width = Context.measureText(Text).width + Size * 1.3;
  const Height = Size * 1.9;
  const Left = X - Width / 2;
  const Top = Y - Height / 2;
  Context.beginPath();
  Context.roundRect(Left, Top, Width, Height, Height / 2);
  Context.fillStyle = Options.Background ?? 'rgba(5, 8, 12, 0.78)';
  Context.fill();
  if (Options.Border) {
    Context.strokeStyle = Options.Border;
    Context.lineWidth = 1;
    Context.stroke();
  }
  Context.fillStyle = Options.Color ?? Theme.Text;
  Context.textAlign = 'center';
  Context.textBaseline = 'middle';
  Context.fillText(Text, X, Y + 0.5);
}
