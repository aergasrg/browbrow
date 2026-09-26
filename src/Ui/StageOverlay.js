// Draws on top of the camera: face mesh, the three skin zones tinted by signal
// quality, zone labels, face-lock brackets, and the pulse tint.

import { FaceOval, MeshEdges, Regions } from '../Vision/FaceGeometry.js';
import { RegionLabels } from '../Vision/Regions.js';
import { Surface, Theme, drawPill, levelColor, withAlpha } from './Canvas.js';
import { levelFor } from './Dom.js';

/** @typedef {import('../Vision/Regions.js').RegionName} RegionName */
/** @typedef {import('../Signal/PulseEngine.js').EngineSnapshot} EngineSnapshot */

/**
 * @typedef {object} OverlayFrame
 * @property {Float32Array | null} Landmarks Normalized [x0, y0, ...] or null.
 * @property {number} FrameWidth Camera frame size in pixels.
 * @property {number} FrameHeight
 * @property {boolean} Mirrored
 * @property {boolean} Demo No video underneath; draw the face as a hologram.
 * @property {'Normal' | 'Pulse' | 'Magnify'} View
 * @property {boolean} ShowMesh
 * @property {boolean} ShowZones
 * @property {boolean} ShowLabels
 * @property {EngineSnapshot['RegionQuality']} RegionQuality
 * @property {number} LatestPulse
 * @property {number} Time Seconds, for animation.
 */

/** @type {RegionName[]} */
const RegionList = ['Forehead', 'LeftCheek', 'RightCheek'];

export class StageOverlay {
  /** @param {HTMLCanvasElement} Canvas */
  constructor(Canvas) {
    this.Surface = new Surface(Canvas);
    this.Points = new Float32Array(478 * 2);
    this.LockedAt = -Infinity;
    this.HadFace = false;
  }

  /** @param {OverlayFrame} Frame */
  render(Frame) {
    const { Context, Width, Height } = this.Surface.begin();
    const Landmarks = Frame.Landmarks;
    if (!Landmarks) {
      this.HadFace = false;
      return;
    }
    if (!this.HadFace) this.LockedAt = Frame.Time;
    this.HadFace = true;

    // Map normalized landmarks through the same "cover" crop as the video element.
    const Scale = Math.max(Width / Frame.FrameWidth, Height / Frame.FrameHeight);
    const OffsetX = (Width - Frame.FrameWidth * Scale) / 2;
    const OffsetY = (Height - Frame.FrameHeight * Scale) / 2;
    const Points = this.Points;
    for (let Index = 0; Index < 478; Index++) {
      let X = OffsetX + Landmarks[Index * 2] * Frame.FrameWidth * Scale;
      if (Frame.Mirrored) X = Width - X;
      Points[Index * 2] = X;
      Points[Index * 2 + 1] = OffsetY + Landmarks[Index * 2 + 1] * Frame.FrameHeight * Scale;
    }

    if (Frame.Demo) this.drawHologram(Context);
    if (Frame.View === 'Pulse') this.drawPulseTint(Context, Frame.LatestPulse);
    if (Frame.ShowMesh || Frame.Demo) this.drawMesh(Context, Frame.Demo ? 0.3 : Frame.View === 'Magnify' ? 0.08 : 0.16);
    if (Frame.ShowZones) this.drawZones(Context, Frame);
    this.drawBrackets(Context, Frame.Time);
    if (Frame.ShowZones && Frame.ShowLabels) this.drawLabels(Context, Frame);
  }

  /** @param {CanvasRenderingContext2D} Context */
  traceOval(Context) {
    const Points = this.Points;
    Context.beginPath();
    FaceOval.forEach((Index, Order) => {
      if (Order === 0) Context.moveTo(Points[Index * 2], Points[Index * 2 + 1]);
      else Context.lineTo(Points[Index * 2], Points[Index * 2 + 1]);
    });
    Context.closePath();
  }

  /** @param {CanvasRenderingContext2D} Context */
  drawHologram(Context) {
    const Box = this.box(FaceOval);
    const Gradient = Context.createRadialGradient(Box.X, Box.Y - Box.Height * 0.1, Box.Width * 0.1, Box.X, Box.Y, Box.Width * 0.75);
    Gradient.addColorStop(0, withAlpha(Theme.Signal, 0.16));
    Gradient.addColorStop(1, withAlpha(Theme.Signal, 0.02));
    this.traceOval(Context);
    Context.fillStyle = Gradient;
    Context.fill();
  }

  /** @param {CanvasRenderingContext2D} Context @param {number} Pulse */
  drawPulseTint(Context, Pulse) {
    const Strength = Math.max(0, Math.min(1, (Pulse + 0.4) / 2.4));
    this.traceOval(Context);
    Context.fillStyle = withAlpha(Theme.Pulse, 0.05 + 0.3 * Strength);
    Context.fill();
    Context.strokeStyle = withAlpha(Theme.Pulse, 0.25 + 0.5 * Strength);
    Context.lineWidth = 1.5;
    Context.stroke();
  }

  /** @param {CanvasRenderingContext2D} Context @param {number} Alpha */
  drawMesh(Context, Alpha) {
    const Points = this.Points;
    Context.beginPath();
    for (let Index = 0; Index < MeshEdges.length; Index += 2) {
      const A = MeshEdges[Index] * 2;
      const B = MeshEdges[Index + 1] * 2;
      Context.moveTo(Points[A], Points[A + 1]);
      Context.lineTo(Points[B], Points[B + 1]);
    }
    Context.strokeStyle = withAlpha(Theme.Signal, Alpha);
    Context.lineWidth = 0.6;
    Context.stroke();
  }

  /** @param {CanvasRenderingContext2D} Context @param {OverlayFrame} Frame */
  drawZones(Context, Frame) {
    const Points = this.Points;
    for (const Name of RegionList) {
      const Quality = Frame.RegionQuality[Name];
      const Color = Quality ? levelColor(levelFor(Quality.Confidence)) : Theme.Info;
      const Triangles = Regions[Name].Triangles;
      Context.beginPath();
      for (let Corner = 0; Corner < Triangles.length; Corner += 3) {
        const A = Triangles[Corner] * 2;
        const B = Triangles[Corner + 1] * 2;
        const C = Triangles[Corner + 2] * 2;
        Context.moveTo(Points[A], Points[A + 1]);
        Context.lineTo(Points[B], Points[B + 1]);
        Context.lineTo(Points[C], Points[C + 1]);
        Context.closePath();
      }
      const PulseBoost = Frame.View === 'Pulse' ? 0.2 * Math.max(0, Frame.LatestPulse) : 0;
      Context.fillStyle = withAlpha(Color, Math.min(0.5, 0.14 + PulseBoost));
      Context.fill();
      Context.beginPath();
      Regions[Name].Boundary.forEach((Index, Order) => {
        if (Order === 0) Context.moveTo(Points[Index * 2], Points[Index * 2 + 1]);
        else Context.lineTo(Points[Index * 2], Points[Index * 2 + 1]);
      });
      Context.closePath();
      Context.strokeStyle = withAlpha(Color, 0.9);
      Context.lineWidth = 1.6;
      Context.stroke();
    }
  }

  /** @param {CanvasRenderingContext2D} Context @param {OverlayFrame} Frame */
  drawLabels(Context, Frame) {
    Context.font = `600 10px ${Theme.Mono}`;
    const Labels = RegionList.map((Name) => {
      const Box = this.box(Regions[Name].Boundary);
      const Quality = Frame.RegionQuality[Name];
      const Text = Quality ? `${RegionLabels[Name].Short} ${Math.round(Quality.Confidence * 100)}%` : RegionLabels[Name].Short;
      return {
        Text,
        Level: Quality ? levelFor(Quality.Confidence) : undefined,
        X: Box.X,
        Y: Name === 'Forehead' ? Box.MinY - 12 : Box.MaxY + 13,
        Width: Context.measureText(Text).width + 13,
      };
    });
    // The two cheek labels share a row; push them apart if they would overlap.
    const [, First, Second] = Labels;
    const [Left, Right] = First.X <= Second.X ? [First, Second] : [Second, First];
    const Overlap = Left.X + Left.Width / 2 + 4 - (Right.X - Right.Width / 2);
    if (Overlap > 0 && Math.abs(Left.Y - Right.Y) < 20) {
      Left.X -= Overlap / 2;
      Right.X += Overlap / 2;
    }
    for (const Label of Labels) {
      const Color = levelColor(Label.Level);
      drawPill(Context, Label.Text, Label.X, Label.Y, { Color, Border: withAlpha(Color, 0.4), Size: 10 });
    }
  }

  /** Corner brackets around the face that snap in when the face is found. @param {CanvasRenderingContext2D} Context @param {number} Time */
  drawBrackets(Context, Time) {
    const Box = this.box(FaceOval);
    const Progress = Math.min(1, (Time - this.LockedAt) / 0.35);
    const Ease = 1 - Math.pow(1 - Progress, 3);
    const Grow = 1.1 + 0.25 * (1 - Ease);
    const HalfWidth = (Box.Width / 2) * Grow;
    const HalfHeight = (Box.Height / 2) * Grow * 0.96;
    const Left = Box.X - HalfWidth;
    const Right = Box.X + HalfWidth;
    const Top = Box.Y - HalfHeight;
    const Bottom = Box.Y + HalfHeight;
    const Arm = Math.min(HalfWidth, HalfHeight) * 0.32;
    Context.strokeStyle = withAlpha(Theme.Signal, 0.35 + 0.6 * Ease);
    Context.lineWidth = 2.5;
    Context.lineCap = 'round';
    Context.beginPath();
    for (const [X, Y, Dx, Dy] of [
      [Left, Top, 1, 1],
      [Right, Top, -1, 1],
      [Left, Bottom, 1, -1],
      [Right, Bottom, -1, -1],
    ]) {
      Context.moveTo(X, Y + Dy * Arm);
      Context.lineTo(X, Y);
      Context.lineTo(X + Dx * Arm, Y);
    }
    Context.stroke();
    if (Progress >= 1) {
      Context.font = `600 9.5px ${Theme.Mono}`;
      Context.fillStyle = withAlpha(Theme.Signal, 0.85);
      Context.textAlign = 'left';
      Context.textBaseline = 'top';
      Context.fillText('FACE LOCK · 478 PTS', Left + 2, Bottom + 6);
    }
  }

  /** Bounding box of some landmarks in screen space. @param {ArrayLike<number>} Indices */
  box(Indices) {
    let MinX = Infinity;
    let MaxX = -Infinity;
    let MinY = Infinity;
    let MaxY = -Infinity;
    for (let Order = 0; Order < Indices.length; Order++) {
      const Index = Indices[Order];
      const X = this.Points[Index * 2];
      const Y = this.Points[Index * 2 + 1];
      if (X < MinX) MinX = X;
      if (X > MaxX) MaxX = X;
      if (Y < MinY) MinY = Y;
      if (Y > MaxY) MaxY = Y;
    }
    return { X: (MinX + MaxX) / 2, Y: (MinY + MaxY) / 2, Width: MaxX - MinX, Height: MaxY - MinY, MinY, MaxY };
  }
}
