// A band-pass filter that stays correct when frames arrive at uneven times.
//
// Camera frames are not evenly spaced (a slow face-tracking frame, a dropped
// frame), and an ordinary digital filter assumes they are. Instead we use the
// continuous-time resonator
//     H(s) = (w0/Q) s / (s^2 + (w0/Q) s + w0^2)
// and step its state exactly across each frame's real time gap (input held
// constant over the gap). The step matrices depend only on the gap, so they
// are computed once per frame and shared by every pixel.

/**
 * @typedef {object} ResonatorStep
 * @property {number} P00 State transition matrix Phi.
 * @property {number} P01
 * @property {number} P10
 * @property {number} P11
 * @property {number} G0 Input vector Gamma.
 * @property {number} G1
 * @property {number} Gain Output = Gain * second state.
 * @property {number} Rest First state value for a constant input of 1 (to start without a transient).
 */

/**
 * State-space step for one frame gap.
 * State z = [z1, z2]: z1' = z2, z2' = -w0^2 z1 - (w0/Q) z2 + u, y = (w0/Q) z2.
 * @param {number} Gap Seconds since the previous frame.
 * @param {number} CenterHz
 * @param {number} BandwidthHz
 * @returns {ResonatorStep}
 */
export function resonatorStep(Gap, CenterHz, BandwidthHz) {
  const Omega = 2 * Math.PI * CenterHz;
  const Damping = 2 * Math.PI * BandwidthHz; // w0 / Q
  const A0 = Omega * Omega;
  const Sigma = Damping / 2;
  const OmegaD = Math.sqrt(Math.max(1e-9, A0 - Sigma * Sigma));
  const Decay = Math.exp(-Sigma * Gap);
  const Cos = Math.cos(OmegaD * Gap);
  const Sin = Math.sin(OmegaD * Gap) / OmegaD;
  // Phi = e^(-Sigma t) [cos(wd t) I + sin(wd t)/wd (A + Sigma I)], A = [[0, 1], [-A0, -Damping]].
  const P00 = Decay * (Cos + Sin * Sigma);
  const P01 = Decay * Sin;
  const P10 = Decay * Sin * -A0;
  const P11 = Decay * (Cos + Sin * (Sigma - Damping));
  // Gamma = A^-1 (Phi - I) B with B = [0, 1] and A^-1 = (1 / A0) [[-Damping, -1], [A0, 0]].
  const G0 = (-Damping * P01 - (P11 - 1)) / A0;
  const G1 = P01;
  return { P00, P01, P10, P11, G0, G1, Gain: Damping, Rest: 1 / A0 };
}
