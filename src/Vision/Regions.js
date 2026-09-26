// Shared types and labels for the skin regions.

import { RegionNames } from './FaceGeometry.js';

/** @typedef {'Forehead' | 'LeftCheek' | 'RightCheek'} RegionName */

/**
 * @typedef {object} RegionColor
 * @property {number} R Mean red, 0..255.
 * @property {number} G Mean green, 0..255.
 * @property {number} B Mean blue, 0..255.
 * @property {number} Count Pixels averaged (0 when the region is hidden).
 */

/**
 * One camera frame's worth of measurements.
 * @typedef {object} Observation
 * @property {Record<RegionName, RegionColor>} Regions
 * @property {number} FaceX Face center, normalized 0..1 across the frame.
 * @property {number} FaceY Face center, normalized 0..1 down the frame.
 * @property {number} FaceWidth Normalized face width.
 * @property {number} FaceHeight Normalized face height.
 * @property {number} Luma Mean brightness of sampled skin, 0..255.
 * @property {number} ClippedFraction Share of skin pixels that were too dark or blown out.
 */

/** @type {Record<RegionName, { Label: string, Short: string }>} */
export const RegionLabels = {
  Forehead: { Label: 'Forehead', Short: 'Brow' },
  LeftCheek: { Label: 'Left cheek', Short: 'L cheek' },
  RightCheek: { Label: 'Right cheek', Short: 'R cheek' },
};

/** @type {readonly RegionName[]} */
export const RegionOrder = RegionNames;
