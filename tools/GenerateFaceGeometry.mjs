// Generates src/Vision/FaceGeometry.js from MediaPipe's canonical face mesh.
//
// The skin regions we read the pulse from (forehead, left cheek, right cheek)
// are chosen geometrically on the canonical face instead of hand-picking
// landmark numbers: every mesh triangle whose centroid falls inside a region's
// box, and that faces the camera, belongs to that region. At runtime the same
// triangles are filled using the live landmarks, so the regions deform with
// the face exactly.
//
// Usage: node tools/GenerateFaceGeometry.mjs [--svg preview.svg]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const Here = path.dirname(fileURLToPath(import.meta.url));
const ObjPath = path.join(Here, 'data', 'canonical_face_model.obj');
const OutPath = path.join(Here, '..', 'src', 'Vision', 'FaceGeometry.js');

const Lines = fs.readFileSync(ObjPath, 'utf8').split('\n');
const Vertices = Lines.filter((Line) => Line.startsWith('v ')).map((Line) => Line.trim().split(/\s+/).slice(1, 4).map(Number));
const Triangles = Lines.filter((Line) => Line.startsWith('f ')).map((Line) =>
  Line.trim().split(/\s+/).slice(1, 4).map((Token) => parseInt(Token, 10) - 1)
);

if (Vertices.length !== 468) throw new Error(`Expected 468 vertices, got ${Vertices.length}`);

// Canonical axes: x < 0 is the subject's right, y is up, z points at the camera.
// Boxes are in canonical units (roughly centimetres). Eyebrow tops sit at
// y = 5.1, lower eyelids at y = 2.3, mouth corners at y = -4.3, nostrils at
// |x| = 1.8.
const RegionBoxes = {
  Forehead: { MinX: -3.9, MaxX: 3.9, MinY: 5.45, MaxY: 7.45 },
  LeftCheek: { MinX: 2.55, MaxX: 5.9, MinY: -2.7, MaxY: 1.35 },
  RightCheek: { MinX: -5.9, MaxX: -2.55, MinY: -2.7, MaxY: 1.35 },
};
const MinFacingZ = 0.45; // Triangle normal must point this much toward the camera.

function sub(A, B) {
  return [A[0] - B[0], A[1] - B[1], A[2] - B[2]];
}
function cross(A, B) {
  return [A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0]];
}
function normalize(A) {
  const Length = Math.hypot(A[0], A[1], A[2]) || 1;
  return [A[0] / Length, A[1] / Length, A[2] / Length];
}

function triangleInfo(Triangle) {
  const [P0, P1, P2] = Triangle.map((Index) => Vertices[Index]);
  const Centroid = [0, 1, 2].map((Axis) => (P0[Axis] + P1[Axis] + P2[Axis]) / 3);
  let Normal = normalize(cross(sub(P1, P0), sub(P2, P0)));
  if (Normal[2] < 0) Normal = Normal.map((Value) => -Value); // Winding may vary; we only care about facing.
  return { Centroid, Normal };
}

/** Edges that belong to exactly one triangle of the set, chained into closed loops. */
function boundaryLoops(TriangleSet) {
  const EdgeCount = new Map();
  for (const Triangle of TriangleSet) {
    for (let Corner = 0; Corner < 3; Corner++) {
      const A = Triangle[Corner];
      const B = Triangle[(Corner + 1) % 3];
      const Key = A < B ? `${A}-${B}` : `${B}-${A}`;
      EdgeCount.set(Key, (EdgeCount.get(Key) || 0) + 1);
    }
  }
  const Neighbors = new Map();
  for (const [Key, Count] of EdgeCount) {
    if (Count !== 1) continue;
    const [A, B] = Key.split('-').map(Number);
    if (!Neighbors.has(A)) Neighbors.set(A, []);
    if (!Neighbors.has(B)) Neighbors.set(B, []);
    Neighbors.get(A).push(B);
    Neighbors.get(B).push(A);
  }
  const Visited = new Set();
  const Loops = [];
  for (const Start of Neighbors.keys()) {
    if (Visited.has(Start)) continue;
    const Loop = [Start];
    Visited.add(Start);
    let Previous = -1;
    let Current = Start;
    for (;;) {
      const Next = Neighbors.get(Current).find((Candidate) => Candidate !== Previous && !Visited.has(Candidate));
      if (Next === undefined) break;
      Loop.push(Next);
      Visited.add(Next);
      Previous = Current;
      Current = Next;
    }
    Loops.push(Loop);
  }
  return Loops.sort((A, B) => B.length - A.length);
}

/** Adds triangles whose corners are all already in the set (closes pinches and pinholes). */
function fillGaps(TriangleSet) {
  const VertexSet = new Set(TriangleSet.flat());
  const Filled = new Set(TriangleSet);
  for (const Triangle of Triangles) {
    if (Triangle.every((Index) => VertexSet.has(Index)) && triangleInfo(Triangle).Normal[2] >= MinFacingZ) {
      Filled.add(Triangle);
    }
  }
  return [...Filled];
}

/** Largest group of triangles connected through shared edges. */
function largestComponent(TriangleSet) {
  const EdgeKey = (A, B) => (A < B ? `${A}-${B}` : `${B}-${A}`);
  const ByEdge = new Map();
  TriangleSet.forEach((Triangle, TriangleIndex) => {
    for (let Corner = 0; Corner < 3; Corner++) {
      const Key = EdgeKey(Triangle[Corner], Triangle[(Corner + 1) % 3]);
      if (!ByEdge.has(Key)) ByEdge.set(Key, []);
      ByEdge.get(Key).push(TriangleIndex);
    }
  });
  const Component = new Array(TriangleSet.length).fill(-1);
  let Best = [];
  for (let Seed = 0; Seed < TriangleSet.length; Seed++) {
    if (Component[Seed] !== -1) continue;
    const Members = [];
    const Stack = [Seed];
    Component[Seed] = Seed;
    while (Stack.length) {
      const Current = Stack.pop();
      Members.push(Current);
      const Triangle = TriangleSet[Current];
      for (let Corner = 0; Corner < 3; Corner++) {
        for (const Other of ByEdge.get(EdgeKey(Triangle[Corner], Triangle[(Corner + 1) % 3]))) {
          if (Component[Other] === -1) {
            Component[Other] = Seed;
            Stack.push(Other);
          }
        }
      }
    }
    if (Members.length > Best.length) Best = Members;
  }
  return Best.map((Index) => TriangleSet[Index]);
}

const Regions = {};
for (const [Name, Box] of Object.entries(RegionBoxes)) {
  const Picked = Triangles.filter((Triangle) => {
    const { Centroid, Normal } = triangleInfo(Triangle);
    return (
      Centroid[0] >= Box.MinX &&
      Centroid[0] <= Box.MaxX &&
      Centroid[1] >= Box.MinY &&
      Centroid[1] <= Box.MaxY &&
      Normal[2] >= MinFacingZ
    );
  });
  const Chosen = largestComponent(fillGaps(Picked));
  const Loops = boundaryLoops(Chosen);
  if (Loops.length !== 1) {
    throw new Error(`${Name}: expected one boundary loop, got ${Loops.length} (sizes ${Loops.map((Loop) => Loop.length)})`);
  }
  Regions[Name] = { Triangles: Chosen, Boundary: Loops[0] };
}

// Unique mesh edges, for drawing the face mesh.
const EdgeSet = new Set();
for (const Triangle of Triangles) {
  for (let Corner = 0; Corner < 3; Corner++) {
    const A = Triangle[Corner];
    const B = Triangle[(Corner + 1) % 3];
    EdgeSet.add(A < B ? `${A}-${B}` : `${B}-${A}`);
  }
}
const Edges = [...EdgeSet].map((Key) => Key.split('-').map(Number)).sort((A, B) => A[0] - B[0] || A[1] - B[1]);

// Outer silhouette of the whole mesh (the longest boundary loop; the others are eyes and mouth).
const FaceOval = boundaryLoops(Triangles)[0];

const Round = (Value) => Math.round(Value * 1000) / 1000;
const Output = `// Generated by tools/GenerateFaceGeometry.mjs from MediaPipe's canonical face
// mesh (Apache 2.0). Do not edit by hand; rerun the generator instead.
//
// Indices refer to MediaPipe Face Landmarker landmarks (0..467).

/** Canonical face vertices, flattened [x, y, z, ...]. x < 0 is the subject's right, y is up, z faces the camera. */
export const CanonicalVertices = new Float32Array(${JSON.stringify(Vertices.flat().map(Round))});

/** Unique mesh edges, flattened [a, b, ...]. */
export const MeshEdges = new Uint16Array(${JSON.stringify(Edges.flat())});

/** Outer silhouette of the face, as an ordered loop of landmark indices. */
export const FaceOval = ${JSON.stringify(FaceOval)};

/**
 * Skin regions used for pulse sampling. Left and right are from the subject's
 * point of view, so on a mirrored selfie view the left cheek is on screen left.
 * Triangles are flattened [a, b, c, ...]; Boundary is an ordered outline loop.
 */
export const Regions = {
${Object.entries(Regions)
  .map(
    ([Name, Region]) =>
      `  ${Name}: {\n    Triangles: new Uint16Array(${JSON.stringify(Region.Triangles.flat())}),\n    Boundary: ${JSON.stringify(Region.Boundary)},\n  },`
  )
  .join('\n')}
};

/** Display order and labels for the regions. */
export const RegionNames = /** @type {const} */ (['Forehead', 'LeftCheek', 'RightCheek']);
`;

fs.writeFileSync(OutPath, Output);
console.log(`Wrote ${path.relative(process.cwd(), OutPath)}`);
for (const [Name, Region] of Object.entries(Regions)) {
  console.log(`  ${Name}: ${Region.Triangles.length} triangles, outline of ${Region.Boundary.length} points`);
}
console.log(`  Mesh: ${Edges.length} edges, face oval of ${FaceOval.length} points`);

// Optional preview: front view of the mesh with the regions filled.
const SvgFlag = process.argv.indexOf('--svg');
if (SvgFlag !== -1) {
  const SvgPath = process.argv[SvgFlag + 1];
  const Scale = 30;
  const toScreen = (Vertex) => [(-Vertex[0] + 9) * Scale, (-Vertex[1] + 10) * Scale]; // Mirrored like a selfie.
  const Colors = { Forehead: '#3ddc97', LeftCheek: '#57b8ff', RightCheek: '#ffb547' };
  let Svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${18 * Scale}" height="${20 * Scale}" style="background:#070b10">`;
  for (const Triangle of Triangles) {
    const Points = Triangle.map((Index) => toScreen(Vertices[Index]).join(',')).join(' ');
    const Facing = triangleInfo(Triangle).Normal[2] > 0.2;
    if (Facing) Svg += `<polygon points="${Points}" fill="none" stroke="#2a3b4a" stroke-width="0.6"/>`;
  }
  for (const [Name, Region] of Object.entries(Regions)) {
    for (const Triangle of Region.Triangles) {
      const Points = Triangle.map((Index) => toScreen(Vertices[Index]).join(',')).join(' ');
      Svg += `<polygon points="${Points}" fill="${Colors[Name]}" fill-opacity="0.45"/>`;
    }
    const Outline = Region.Boundary.map((Index) => toScreen(Vertices[Index]).join(',')).join(' ');
    Svg += `<polygon points="${Outline}" fill="none" stroke="${Colors[Name]}" stroke-width="2"/>`;
  }
  const Oval = FaceOval.map((Index) => toScreen(Vertices[Index]).join(',')).join(' ');
  Svg += `<polygon points="${Oval}" fill="none" stroke="#ff4d6d" stroke-width="1.5"/>`;
  Svg += '</svg>';
  fs.writeFileSync(SvgPath, Svg);
  console.log(`Wrote preview ${SvgPath}`);
}
