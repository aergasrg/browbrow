// Eulerian Video Magnification for color (Wu et al., MIT, 2012), simplified
// for the browser.
//
// 1. Shrink each frame to a tiny image (the spatial blur averages away camera
//    noise; the pulse is the same across a patch of skin).
// 2. Band-pass every tiny pixel over time around the current heart rate
//    (with a filter that handles uneven frame timing, see Resonator.js).
// 3. Multiply that change by a large gain and add it back to the full frame.
//
// The skin's real, invisible color change becomes a visible flush with each
// beat. Steps 1 and 2 run in JavaScript on about 3,000 pixels; step 3 is a
// WebGL shader so the full-resolution frame never touches the CPU.

import { FaceOval } from '../Vision/FaceGeometry.js';
import { resonatorStep } from './Resonator.js';

const VertexShader = `
attribute vec2 Position;
varying vec2 ScreenUv;
void main() {
  ScreenUv = vec2(Position.x * 0.5 + 0.5, 0.5 - Position.y * 0.5);
  gl_Position = vec4(Position, 0.0, 1.0);
}`;

const FragmentShader = `
precision mediump float;
varying vec2 ScreenUv;
uniform sampler2D VideoTexture;
uniform sampler2D DeltaTexture;
uniform vec2 UvScale;
uniform vec2 UvOffset;
uniform float Mirrored;
uniform float DeltaRange;
void main() {
  vec2 Uv = ScreenUv * UvScale + UvOffset;
  if (Mirrored > 0.5) Uv.x = 1.0 - Uv.x;
  vec3 Color = texture2D(VideoTexture, Uv).rgb;
  vec3 Delta = (texture2D(DeltaTexture, Uv).rgb - 0.5) * DeltaRange;
  gl_FragColor = vec4(clamp(Color + Delta, 0.0, 1.0), 1.0);
}`;

const LowSize = 64; // Long side of the processing image.
const MaxDelta = 90; // Clamp on the amplified change, 0..255 units.

export class PulseMagnifier {
  /** @param {HTMLCanvasElement} Canvas Display canvas. */
  constructor(Canvas) {
    this.Canvas = Canvas;
    const Gl = /** @type {WebGLRenderingContext | null} */ (Canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false }));
    if (!Gl) throw new Error('WebGL is not available');
    this.Gl = Gl;
    this.Program = this.buildProgram();
    this.VideoTexture = this.createTexture(Gl.LINEAR);
    this.DeltaTexture = this.createTexture(Gl.LINEAR);
    const Buffer = Gl.createBuffer();
    Gl.bindBuffer(Gl.ARRAY_BUFFER, Buffer);
    Gl.bufferData(Gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), Gl.STATIC_DRAW);
    const PositionLocation = Gl.getAttribLocation(this.Program, 'Position');
    Gl.enableVertexAttribArray(PositionLocation);
    Gl.vertexAttribPointer(PositionLocation, 2, Gl.FLOAT, false, 0, 0);

    this.Small = document.createElement('canvas');
    const SmallContext = this.Small.getContext('2d', { willReadFrequently: true });
    const MaskContext = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!SmallContext || !MaskContext) throw new Error('Canvas 2D is not available');
    this.SmallContext = SmallContext;
    // High-quality downscaling averages many camera pixels into each small pixel (less noise).
    this.SmallContext.imageSmoothingEnabled = true;
    this.SmallContext.imageSmoothingQuality = 'high';
    this.MaskContext = MaskContext;
    this.Gain = 80;
    this.CenterHz = 1.2;
    this.BandwidthHz = 0.5;
    this.LastTime = 0;
    this.Width = 0;
    this.Height = 0;
    this.HasFrame = false;
  }

  buildProgram() {
    const Gl = this.Gl;
    /** @param {number} Kind @param {string} Source */
    const compile = (Kind, Source) => {
      const Shader = /** @type {WebGLShader} */ (Gl.createShader(Kind));
      Gl.shaderSource(Shader, Source);
      Gl.compileShader(Shader);
      if (!Gl.getShaderParameter(Shader, Gl.COMPILE_STATUS)) throw new Error(Gl.getShaderInfoLog(Shader) || 'Shader failed');
      return Shader;
    };
    const Program = /** @type {WebGLProgram} */ (Gl.createProgram());
    Gl.attachShader(Program, compile(Gl.VERTEX_SHADER, VertexShader));
    Gl.attachShader(Program, compile(Gl.FRAGMENT_SHADER, FragmentShader));
    Gl.linkProgram(Program);
    if (!Gl.getProgramParameter(Program, Gl.LINK_STATUS)) throw new Error(Gl.getProgramInfoLog(Program) || 'Link failed');
    Gl.useProgram(Program);
    Gl.uniform1i(Gl.getUniformLocation(Program, 'VideoTexture'), 0);
    Gl.uniform1i(Gl.getUniformLocation(Program, 'DeltaTexture'), 1);
    return Program;
  }

  /** @param {number} Filter */
  createTexture(Filter) {
    const Gl = this.Gl;
    const Texture = Gl.createTexture();
    Gl.bindTexture(Gl.TEXTURE_2D, Texture);
    Gl.texParameteri(Gl.TEXTURE_2D, Gl.TEXTURE_MIN_FILTER, Filter);
    Gl.texParameteri(Gl.TEXTURE_2D, Gl.TEXTURE_MAG_FILTER, Filter);
    Gl.texParameteri(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_S, Gl.CLAMP_TO_EDGE);
    Gl.texParameteri(Gl.TEXTURE_2D, Gl.TEXTURE_WRAP_T, Gl.CLAMP_TO_EDGE);
    return Texture;
  }

  /** @param {number} Gain */
  setGain(Gain) {
    this.Gain = Gain;
  }

  /** Tunes the band to the measured heart rate. @param {number | null} Bpm */
  setHeartRate(Bpm) {
    this.CenterHz = Bpm ? Bpm / 60 : 1.2;
  }

  /** @param {number} Width @param {number} Height */
  allocate(Width, Height) {
    this.Width = Width;
    this.Height = Height;
    this.Small.width = Width;
    this.Small.height = Height;
    this.MaskContext.canvas.width = Width;
    this.MaskContext.canvas.height = Height;
    const Size = Width * Height * 3;
    this.Z1 = new Float32Array(Size);
    this.Z2 = new Float32Array(Size);
    this.Mask = new Float32Array(Width * Height);
    this.Amplified = new Float32Array(Size);
    this.Scratch = new Float32Array(Size);
    this.Delta = new Uint8ClampedArray(Width * Height * 4);
    this.HasFrame = false;
  }

  reset() {
    this.HasFrame = false;
  }

  /**
   * Processes one video frame.
   * @param {HTMLVideoElement} Video
   * @param {number} Time Seconds.
   * @param {Float32Array | null} Landmarks Normalized face landmarks, to confine the effect to the face.
   */
  process(Video, Time, Landmarks) {
    const VideoWidth = Video.videoWidth;
    const VideoHeight = Video.videoHeight;
    if (!VideoWidth || !VideoHeight) return;
    const Aspect = VideoWidth / VideoHeight;
    const Width = Aspect >= 1 ? LowSize : Math.round(LowSize * Aspect);
    const Height = Aspect >= 1 ? Math.round(LowSize / Aspect) : LowSize;
    if (Width !== this.Width || Height !== this.Height) this.allocate(Width, Height);
    const Gap = Time - this.LastTime;
    if (Gap > 0.5 || Gap <= 0) this.HasFrame = false; // Stalled or restarted: settle again.
    this.LastTime = Time;
    this.SmallContext.drawImage(Video, 0, 0, Width, Height);
    const Pixels = this.SmallContext.getImageData(0, 0, Width, Height).data;
    this.updateMask(Landmarks);

    const Z1 = /** @type {Float32Array} */ (this.Z1);
    const Z2 = /** @type {Float32Array} */ (this.Z2);
    const Mask = /** @type {Float32Array} */ (this.Mask);
    const Delta = /** @type {Uint8ClampedArray} */ (this.Delta);
    const PixelCount = Width * Height;
    const Step = resonatorStep(this.HasFrame ? Gap : 1 / 30, this.CenterHz, this.BandwidthHz);
    if (!this.HasFrame) {
      // Start every pixel at rest for its current color, so nothing flashes.
      for (let Pixel = 0; Pixel < PixelCount; Pixel++) {
        for (let Channel = 0; Channel < 3; Channel++) {
          Z1[Pixel * 3 + Channel] = Pixels[Pixel * 4 + Channel] * Step.Rest;
          Z2[Pixel * 3 + Channel] = 0;
        }
      }
      this.HasFrame = true;
    }
    const { P00, P01, P10, P11, G0, G1 } = Step;
    const Amplified = /** @type {Float32Array} */ (this.Amplified);
    for (let Pixel = 0; Pixel < PixelCount; Pixel++) {
      const Weight = Mask[Pixel] * this.Gain * Step.Gain;
      for (let Channel = 0; Channel < 3; Channel++) {
        const Index = Pixel * 3 + Channel;
        const X = Pixels[Pixel * 4 + Channel];
        const State1 = Z1[Index];
        const State2 = Z2[Index];
        Z1[Index] = P00 * State1 + P01 * State2 + G0 * X;
        Z2[Index] = P10 * State1 + P11 * State2 + G1 * X;
        Amplified[Index] = Z2[Index] * Weight;
      }
    }
    // Two passes of a 3x3 box blur approximate a Gaussian: the pulse is shared by
    // neighboring skin, camera noise is not.
    this.blur(Amplified);
    this.blur(Amplified);
    for (let Pixel = 0; Pixel < PixelCount; Pixel++) {
      for (let Channel = 0; Channel < 3; Channel++) {
        const Value = Math.max(-MaxDelta, Math.min(MaxDelta, Amplified[Pixel * 3 + Channel]));
        Delta[Pixel * 4 + Channel] = 127.5 + (Value * 127.5) / MaxDelta;
      }
      Delta[Pixel * 4 + 3] = 255;
    }
    const Gl = this.Gl;
    Gl.activeTexture(Gl.TEXTURE1);
    Gl.bindTexture(Gl.TEXTURE_2D, this.DeltaTexture);
    Gl.pixelStorei(Gl.UNPACK_ALIGNMENT, 1);
    Gl.texImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA, Width, Height, 0, Gl.RGBA, Gl.UNSIGNED_BYTE, Delta);
  }

  /** Separable 3x3 box blur of an RGB float image, in place. @param {Float32Array} Image */
  blur(Image) {
    const Width = this.Width;
    const Height = this.Height;
    const Scratch = /** @type {Float32Array} */ (this.Scratch);
    for (let Row = 0; Row < Height; Row++) {
      for (let Column = 0; Column < Width; Column++) {
        const Left = Math.max(0, Column - 1);
        const Right = Math.min(Width - 1, Column + 1);
        for (let Channel = 0; Channel < 3; Channel++) {
          const Base = Row * Width;
          Scratch[(Base + Column) * 3 + Channel] =
            (Image[(Base + Left) * 3 + Channel] + Image[(Base + Column) * 3 + Channel] + Image[(Base + Right) * 3 + Channel]) / 3;
        }
      }
    }
    for (let Row = 0; Row < Height; Row++) {
      const Up = Math.max(0, Row - 1);
      const Down = Math.min(Height - 1, Row + 1);
      for (let Column = 0; Column < Width; Column++) {
        for (let Channel = 0; Channel < 3; Channel++) {
          Image[(Row * Width + Column) * 3 + Channel] =
            (Scratch[(Up * Width + Column) * 3 + Channel] + Scratch[(Row * Width + Column) * 3 + Channel] + Scratch[(Down * Width + Column) * 3 + Channel]) / 3;
        }
      }
    }
  }

  /** Soft mask over the face so the background is left alone. @param {Float32Array | null} Landmarks */
  updateMask(Landmarks) {
    const Mask = /** @type {Float32Array} */ (this.Mask);
    if (!Landmarks) {
      for (let Index = 0; Index < Mask.length; Index++) Mask[Index] *= 0.85;
      return;
    }
    const Context = this.MaskContext;
    const Width = this.Width;
    const Height = this.Height;
    Context.clearRect(0, 0, Width, Height);
    Context.filter = 'blur(1.5px)';
    Context.fillStyle = '#fff';
    Context.beginPath();
    FaceOval.forEach((Index, Order) => {
      const X = Landmarks[Index * 2] * Width;
      const Y = Landmarks[Index * 2 + 1] * Height;
      if (Order === 0) Context.moveTo(X, Y);
      else Context.lineTo(X, Y);
    });
    Context.closePath();
    Context.fill();
    Context.filter = 'none';
    const Alpha = Context.getImageData(0, 0, Width, Height).data;
    for (let Index = 0; Index < Mask.length; Index++) Mask[Index] = Alpha[Index * 4 + 3] / 255;
  }

  /**
   * Draws the current video frame with the amplified change added.
   * @param {HTMLVideoElement} Video
   * @param {boolean} Mirrored
   */
  render(Video, Mirrored) {
    const Gl = this.Gl;
    const Canvas = this.Canvas;
    const Ratio = Math.min(2, window.devicePixelRatio || 1);
    const DisplayWidth = Math.round(Canvas.clientWidth * Ratio);
    const DisplayHeight = Math.round(Canvas.clientHeight * Ratio);
    if (!DisplayWidth || !DisplayHeight || !Video.videoWidth || !this.HasFrame) return;
    if (Canvas.width !== DisplayWidth || Canvas.height !== DisplayHeight) {
      Canvas.width = DisplayWidth;
      Canvas.height = DisplayHeight;
    }
    Gl.viewport(0, 0, DisplayWidth, DisplayHeight);
    Gl.activeTexture(Gl.TEXTURE0);
    Gl.bindTexture(Gl.TEXTURE_2D, this.VideoTexture);
    Gl.pixelStorei(Gl.UNPACK_ALIGNMENT, 4);
    Gl.texImage2D(Gl.TEXTURE_2D, 0, Gl.RGBA, Gl.RGBA, Gl.UNSIGNED_BYTE, Video);
    // Same "object-fit: cover" crop as the video element.
    const Scale = Math.max(DisplayWidth / Video.videoWidth, DisplayHeight / Video.videoHeight);
    const ShownWidth = Video.videoWidth * Scale;
    const ShownHeight = Video.videoHeight * Scale;
    Gl.uniform2f(Gl.getUniformLocation(this.Program, 'UvScale'), DisplayWidth / ShownWidth, DisplayHeight / ShownHeight);
    Gl.uniform2f(
      Gl.getUniformLocation(this.Program, 'UvOffset'),
      (ShownWidth - DisplayWidth) / 2 / ShownWidth,
      (ShownHeight - DisplayHeight) / 2 / ShownHeight
    );
    Gl.uniform1f(Gl.getUniformLocation(this.Program, 'Mirrored'), Mirrored ? 1 : 0);
    // Texture value v encodes (v - 0.5) * 2 * MaxDelta / 255 in 0..1 color units.
    Gl.uniform1f(Gl.getUniformLocation(this.Program, 'DeltaRange'), (2 * MaxDelta) / 255);
    Gl.drawArrays(Gl.TRIANGLE_STRIP, 0, 4);
  }
}
