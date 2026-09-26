// Averages the skin color inside each face region, every frame.
//
// The regions are unions of face-mesh triangles (see FaceGeometry.js), filled
// with the live landmark positions, so they stretch and turn with the face.

import { Regions } from './FaceGeometry.js';

/** @typedef {import('./Regions.js').RegionName} RegionName */
/** @typedef {import('./Regions.js').Observation} Observation */

/** @type {RegionName[]} */
const RegionList = ['Forehead', 'LeftCheek', 'RightCheek'];

// All landmark indices used by any region, for the bounding box.
const UsedIndices = [...new Set(RegionList.flatMap((Name) => Array.from(Regions[Name].Triangles)))];

/**
 * Accumulates the average color of each region's triangles from an RGBA pixel
 * block. Pixels count when their center lies inside a triangle (half-open
 * edges, so shared edges are not counted twice). Near-black and blown-out
 * pixels are skipped: they carry no pulse and would dilute it.
 *
 * @param {Uint8ClampedArray} Data RGBA pixels of the block.
 * @param {number} Width Block width.
 * @param {number} Height Block height.
 * @param {number} OriginX Block's left edge in frame pixels.
 * @param {number} OriginY Block's top edge in frame pixels.
 * @param {ArrayLike<number>} Points Landmarks in frame pixels, flattened [x0, y0, x1, y1, ...].
 * @param {Record<RegionName, ArrayLike<number>>} RegionTriangles Flattened triangle indices per region.
 * @returns {Pick<Observation, 'Regions' | 'Luma' | 'ClippedFraction'>}
 */
export function accumulateRegions(Data, Width, Height, OriginX, OriginY, Points, RegionTriangles) {
  /** @type {Partial<Observation['Regions']>} */
  const Result = {};
  let LumaSum = 0;
  let Used = 0;
  let Skipped = 0;
  for (const Name of RegionList) {
    const Triangles = RegionTriangles[Name];
    let SumR = 0;
    let SumG = 0;
    let SumB = 0;
    let Count = 0;
    for (let Corner = 0; Corner < Triangles.length; Corner += 3) {
      const A = Triangles[Corner] * 2;
      const B = Triangles[Corner + 1] * 2;
      const C = Triangles[Corner + 2] * 2;
      const Xs = [Points[A] - OriginX, Points[B] - OriginX, Points[C] - OriginX];
      const Ys = [Points[A + 1] - OriginY, Points[B + 1] - OriginY, Points[C + 1] - OriginY];
      const Top = Math.max(0, Math.ceil(Math.min(Ys[0], Ys[1], Ys[2]) - 0.5));
      const Bottom = Math.min(Height - 1, Math.ceil(Math.max(Ys[0], Ys[1], Ys[2]) - 0.5) - 1);
      for (let Row = Top; Row <= Bottom; Row++) {
        const CenterY = Row + 0.5;
        let Left = Infinity;
        let Right = -Infinity;
        for (let Edge = 0; Edge < 3; Edge++) {
          const X0 = Xs[Edge];
          const Y0 = Ys[Edge];
          const X1 = Xs[(Edge + 1) % 3];
          const Y1 = Ys[(Edge + 1) % 3];
          if ((CenterY >= Y0 && CenterY < Y1) || (CenterY >= Y1 && CenterY < Y0)) {
            const X = X0 + ((CenterY - Y0) / (Y1 - Y0)) * (X1 - X0);
            if (X < Left) Left = X;
            if (X > Right) Right = X;
          }
        }
        if (Left > Right) continue;
        const First = Math.max(0, Math.ceil(Left - 0.5));
        const Last = Math.min(Width - 1, Math.ceil(Right - 0.5) - 1);
        let Offset = (Row * Width + First) * 4;
        for (let Column = First; Column <= Last; Column++, Offset += 4) {
          const R = Data[Offset];
          const G = Data[Offset + 1];
          const Bl = Data[Offset + 2];
          const Luma = 0.299 * R + 0.587 * G + 0.114 * Bl;
          if (Luma < 12 || R > 250 || G > 250 || Bl > 250) {
            Skipped++;
            continue;
          }
          SumR += R;
          SumG += G;
          SumB += Bl;
          LumaSum += Luma;
          Count++;
        }
      }
    }
    Used += Count;
    Result[Name] = Count ? { R: SumR / Count, G: SumG / Count, B: SumB / Count, Count } : { R: 0, G: 0, B: 0, Count: 0 };
  }
  return {
    Regions: /** @type {Observation['Regions']} */ (Result),
    Luma: Used ? LumaSum / Used : 0,
    ClippedFraction: Used + Skipped ? Skipped / (Used + Skipped) : 0,
  };
}

/**
 * Face position and size from normalized landmarks.
 * @param {ArrayLike<number>} Landmarks Normalized [x0, y0, ...].
 */
export function faceBox(Landmarks) {
  let MinX = Infinity;
  let MaxX = -Infinity;
  let MinY = Infinity;
  let MaxY = -Infinity;
  for (let Index = 0; Index < 468 * 2; Index += 2) {
    const X = Landmarks[Index];
    const Y = Landmarks[Index + 1];
    if (X < MinX) MinX = X;
    if (X > MaxX) MaxX = X;
    if (Y < MinY) MinY = Y;
    if (Y > MaxY) MaxY = Y;
  }
  return { X: (MinX + MaxX) / 2, Y: (MinY + MaxY) / 2, Width: MaxX - MinX, Height: MaxY - MinY, MinX, MaxX, MinY, MaxY };
}

/** Reads video frames into a canvas and samples the regions. */
export class SkinSampler {
  constructor() {
    this.Canvas = document.createElement('canvas');
    const Context = this.Canvas.getContext('2d', { willReadFrequently: true });
    if (!Context) throw new Error('Canvas 2D is not available');
    this.Context = Context;
    this.Points = new Float32Array(478 * 2);
    this.LastPixels = 0;
  }

  /**
   * @param {CanvasImageSource} Source Current video frame.
   * @param {number} SourceWidth Frame width in pixels.
   * @param {number} SourceHeight Frame height in pixels.
   * @param {Float32Array} Landmarks Normalized landmarks [x0, y0, ...].
   * @returns {Observation}
   */
  sample(Source, SourceWidth, SourceHeight, Landmarks) {
    // Sample at up to 640 px wide: plenty of skin pixels, modest readback cost.
    const Scale = Math.min(1, 640 / SourceWidth);
    const Width = Math.round(SourceWidth * Scale);
    const Height = Math.round(SourceHeight * Scale);
    if (this.Canvas.width !== Width || this.Canvas.height !== Height) {
      this.Canvas.width = Width;
      this.Canvas.height = Height;
    }
    for (let Index = 0; Index < Landmarks.length && Index < this.Points.length; Index += 2) {
      this.Points[Index] = Landmarks[Index] * Width;
      this.Points[Index + 1] = Landmarks[Index + 1] * Height;
    }
    let MinX = Infinity;
    let MaxX = -Infinity;
    let MinY = Infinity;
    let MaxY = -Infinity;
    for (const Index of UsedIndices) {
      const X = this.Points[Index * 2];
      const Y = this.Points[Index * 2 + 1];
      if (X < MinX) MinX = X;
      if (X > MaxX) MaxX = X;
      if (Y < MinY) MinY = Y;
      if (Y > MaxY) MaxY = Y;
    }
    const Box = faceBox(Landmarks);
    const Left = Math.max(0, Math.floor(MinX) - 1);
    const Top = Math.max(0, Math.floor(MinY) - 1);
    const Right = Math.min(Width, Math.ceil(MaxX) + 1);
    const Bottom = Math.min(Height, Math.ceil(MaxY) + 1);
    const Base = { FaceX: Box.X, FaceY: Box.Y, FaceWidth: Box.Width, FaceHeight: Box.Height };
    if (Right - Left < 2 || Bottom - Top < 2) {
      const Empty = { R: 0, G: 0, B: 0, Count: 0 };
      return { ...Base, Regions: { Forehead: Empty, LeftCheek: Empty, RightCheek: Empty }, Luma: 0, ClippedFraction: 1 };
    }
    this.Context.drawImage(Source, 0, 0, Width, Height);
    const Pixels = this.Context.getImageData(Left, Top, Right - Left, Bottom - Top);
    const Sampled = accumulateRegions(Pixels.data, Pixels.width, Pixels.height, Left, Top, this.Points, {
      Forehead: Regions.Forehead.Triangles,
      LeftCheek: Regions.LeftCheek.Triangles,
      RightCheek: Regions.RightCheek.Triangles,
    });
    this.LastPixels = Sampled.Regions.Forehead.Count + Sampled.Regions.LeftCheek.Count + Sampled.Regions.RightCheek.Count;
    return { ...Base, ...Sampled };
  }
}
