import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalVertices, FaceOval, MeshEdges, Regions } from '../src/Vision/FaceGeometry.js';
import { accumulateRegions, faceBox } from '../src/Vision/SkinSampler.js';
import { demoLandmarks } from '../src/Sim/DemoFace.js';

test('face geometry is well formed', () => {
  assert.equal(CanonicalVertices.length, 468 * 3);
  assert.equal(MeshEdges.length % 2, 0);
  assert.ok(FaceOval.length > 30);
  for (const [Name, Region] of Object.entries(Regions)) {
    assert.equal(Region.Triangles.length % 3, 0, Name);
    assert.ok(Region.Triangles.length / 3 >= 15, `${Name} has enough triangles`);
    assert.ok(Array.from(Region.Triangles).every((Index) => Index < 468), `${Name} indices in range`);
    assert.ok(Region.Boundary.length >= 8, `${Name} outline`);
  }
  // Left cheek is on the subject's left (canonical x > 0), right cheek on the right.
  /** @param {ArrayLike<number>} Triangles */
  const meanX = (Triangles) => Array.from(Triangles).reduce((Sum, Index) => Sum + CanonicalVertices[Index * 3], 0) / Triangles.length;
  assert.ok(meanX(Regions.LeftCheek.Triangles) > 2);
  assert.ok(meanX(Regions.RightCheek.Triangles) < -2);
  assert.ok(Math.abs(meanX(Regions.Forehead.Triangles)) < 0.5);
});

test('region sampling averages exactly the pixels inside the triangles', () => {
  const Width = 40;
  const Height = 30;
  const Data = new Uint8ClampedArray(Width * Height * 4);
  for (let Row = 0; Row < Height; Row++) {
    for (let Column = 0; Column < Width; Column++) {
      const Offset = (Row * Width + Column) * 4;
      // Left half one color, right half another.
      Data.set(Column < 20 ? [200, 100, 50, 255] : [100, 150, 200, 255], Offset);
    }
  }
  // Three landmarks forming a 10x10 right triangle in the left half, and a square (two triangles) on the right.
  const Points = new Float32Array(478 * 2);
  const place = (/** @type {number} */ Index, /** @type {number} */ X, /** @type {number} */ Y) => {
    Points[Index * 2] = X;
    Points[Index * 2 + 1] = Y;
  };
  place(0, 2, 2);
  place(1, 12, 2);
  place(2, 2, 12);
  place(3, 24, 4);
  place(4, 34, 4);
  place(5, 34, 14);
  place(6, 24, 14);
  const Result = accumulateRegions(Data, Width, Height, 0, 0, Points, {
    Forehead: [0, 1, 2],
    LeftCheek: [3, 4, 5, 3, 5, 6],
    RightCheek: [],
  });
  assert.deepEqual([Result.Regions.Forehead.R, Result.Regions.Forehead.G, Result.Regions.Forehead.B], [200, 100, 50]);
  // Pixel-center rule: centers (c + 0.5, r + 0.5) with x >= 2, y >= 2, x + y < 14 give 9 + 8 + ... + 1.
  assert.equal(Result.Regions.Forehead.Count, 45);
  // Shared diagonal counted once: the square has exactly 100 pixels.
  assert.equal(Result.Regions.LeftCheek.Count, 100);
  assert.equal(Result.Regions.LeftCheek.G, 150);
  assert.equal(Result.Regions.RightCheek.Count, 0);
  assert.equal(Result.ClippedFraction, 0);
});

test('blown-out pixels are skipped and reported', () => {
  const Data = new Uint8ClampedArray(10 * 10 * 4).fill(255);
  const Points = new Float32Array(478 * 2);
  Points.set([0, 0, 10, 0, 0, 10, 10, 10], 0);
  const Result = accumulateRegions(Data, 10, 10, 0, 0, Points, { Forehead: [0, 1, 2, 1, 3, 2], LeftCheek: [], RightCheek: [] });
  assert.equal(Result.Regions.Forehead.Count, 0);
  assert.equal(Result.ClippedFraction, 1);
});

test('demo face is upright and mirrored like a real camera image', () => {
  const Landmarks = demoLandmarks(0, 0, 0, new Float32Array(478 * 2));
  const Box = faceBox(Landmarks);
  assert.ok(Box.Width > 0.3 && Box.Width < 0.6, `width ${Box.Width}`);
  assert.ok(Landmarks[10 * 2 + 1] < Landmarks[152 * 2 + 1], 'forehead above chin');
  // Unmirrored camera image: the subject's right eye (33) is on the image left.
  assert.ok(Landmarks[33 * 2] < Landmarks[263 * 2]);
});

test('magnifier resonator passes the heart rate and blocks the rest, even with uneven frames', async () => {
  const { resonatorStep } = await import('../src/Magnify/Resonator.js');
  const { createRandom } = await import('../src/Signal/Stats.js');
  /** Runs a sine through the filter with jittery gaps (4 to 60 fps) and returns the output amplitude. @param {number} Hz */
  const amplitude = (Hz) => {
    const Random = createRandom(5);
    let Time = 0;
    let Z1 = 100 / (2 * Math.PI * 1.6) ** 2; // Start at rest for an input of 100.
    let Z2 = 0;
    let Largest = 0;
    while (Time < 30) {
      const Gap = 1 / 60 + Random.next() * (1 / 4 - 1 / 60);
      const Step = resonatorStep(Gap, 1.6, 0.5);
      const Input = 100 + Math.sin(2 * Math.PI * Hz * Time); // Input is sampled at the start of the gap.
      const Next1 = Step.P00 * Z1 + Step.P01 * Z2 + Step.G0 * Input;
      const Next2 = Step.P10 * Z1 + Step.P11 * Z2 + Step.G1 * Input;
      Z1 = Next1;
      Z2 = Next2;
      Time += Gap;
      if (Time > 10) Largest = Math.max(Largest, Math.abs(Step.Gain * Z2));
    }
    return Largest;
  };
  assert.ok(Math.abs(amplitude(1.6) - 1) < 0.25, `at the heart rate: ${amplitude(1.6).toFixed(2)}`);
  assert.ok(amplitude(0.5) < 0.35, `below: ${amplitude(0.5).toFixed(2)}`);
  assert.ok(amplitude(0) < 0.01, `constant brightness: ${amplitude(0)}`);
});
