// A virtual face for demo mode: the canonical face mesh, gently turning and
// breathing, projected into a portrait "camera frame". Produces landmarks in
// the same format as the real face tracker, so the whole UI works unchanged.

import { CanonicalVertices } from '../Vision/FaceGeometry.js';

/** Size of the pretend camera frame. */
export const DemoFrame = { Width: 480, Height: 640 };

const Scale = 0.44 / 15.5; // Face spans about 44% of the frame width.

/**
 * @param {number} Time Seconds.
 * @param {number} Breath -1..1 breathing phase.
 * @param {number} Sway 0..1 extra head movement (motion bursts).
 * @param {Float32Array} Out Receives normalized [x0, y0, ...] for 478 points.
 */
export function demoLandmarks(Time, Breath, Sway, Out) {
  const Yaw = (8 + 10 * Sway) * (Math.PI / 180) * Math.sin((2 * Math.PI * Time) / 13);
  const Pitch = (4 * Math.sin((2 * Math.PI * Time) / 9) + 2 * Breath) * (Math.PI / 180);
  const Roll = 2 * (Math.PI / 180) * Math.sin((2 * Math.PI * Time) / 17);
  const CenterX = 0.5 + 0.012 * Math.sin((2 * Math.PI * Time) / 23);
  const CenterY = 0.47 + 0.004 * Breath;
  const Aspect = DemoFrame.Width / DemoFrame.Height;
  const CosYaw = Math.cos(Yaw);
  const SinYaw = Math.sin(Yaw);
  const CosPitch = Math.cos(Pitch);
  const SinPitch = Math.sin(Pitch);
  const CosRoll = Math.cos(Roll);
  const SinRoll = Math.sin(Roll);
  for (let Index = 0; Index < 468; Index++) {
    const X = CanonicalVertices[Index * 3];
    const Y = CanonicalVertices[Index * 3 + 1];
    const Z = CanonicalVertices[Index * 3 + 2];
    // Yaw about the vertical axis, pitch about the horizontal, roll in the image plane.
    const X1 = X * CosYaw + Z * SinYaw;
    const Z1 = -X * SinYaw + Z * CosYaw;
    const Y2 = Y * CosPitch - Z1 * SinPitch;
    const X3 = X1 * CosRoll - Y2 * SinRoll;
    const Y3 = X1 * SinRoll + Y2 * CosRoll;
    // The subject's right (x < 0) appears on the left of an unmirrored camera image.
    Out[Index * 2] = CenterX + X3 * Scale;
    Out[Index * 2 + 1] = CenterY - Y3 * Scale * Aspect;
  }
  // Iris points (468..477) are unused; park them at the eye centers.
  for (let Index = 468; Index < 478; Index++) {
    const [Outer, Inner] = Index < 473 ? [33, 133] : [263, 362];
    Out[Index * 2] = (Out[Outer * 2] + Out[Inner * 2]) / 2;
    Out[Index * 2 + 1] = (Out[Outer * 2 + 1] + Out[Inner * 2 + 1]) / 2;
  }
  return Out;
}
