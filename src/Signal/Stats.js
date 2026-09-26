// Small numeric helpers used by the signal code.

/** @typedef {ArrayLike<number>} NumberList */

/** @param {NumberList} Values */
export function mean(Values) {
  let Sum = 0;
  for (let Index = 0; Index < Values.length; Index++) Sum += Values[Index];
  return Values.length ? Sum / Values.length : 0;
}

/** Population standard deviation. @param {NumberList} Values */
export function std(Values) {
  if (Values.length === 0) return 0;
  const Mean = mean(Values);
  let Sum = 0;
  for (let Index = 0; Index < Values.length; Index++) {
    const Delta = Values[Index] - Mean;
    Sum += Delta * Delta;
  }
  return Math.sqrt(Sum / Values.length);
}

/** @param {NumberList} Values */
export function median(Values) {
  if (Values.length === 0) return 0;
  const Sorted = Array.from(Values).sort((A, B) => A - B);
  const Middle = Sorted.length >> 1;
  return Sorted.length % 2 ? Sorted[Middle] : (Sorted[Middle - 1] + Sorted[Middle]) / 2;
}

/** @param {number} Value @param {number} Low @param {number} High */
export function clamp(Value, Low, High) {
  return Math.min(High, Math.max(Low, Value));
}

/**
 * Standard deviation estimated from the median absolute deviation, which
 * ignores the occasional motion spike.
 * @param {NumberList} Values
 */
export function robustStd(Values) {
  const Center = median(Values);
  const Deviations = new Float64Array(Values.length);
  for (let Index = 0; Index < Values.length; Index++) Deviations[Index] = Math.abs(Values[Index] - Center);
  return 1.4826 * median(Deviations);
}

/**
 * Deterministic pseudo-random generator (mulberry32) so simulations and tests
 * are repeatable.
 * @param {number} Seed
 */
export function createRandom(Seed) {
  let State = Seed >>> 0;
  const next = () => {
    State = (State + 0x6d2b79f5) >>> 0;
    let Value = State;
    Value = Math.imul(Value ^ (Value >>> 15), Value | 1);
    Value ^= Value + Math.imul(Value ^ (Value >>> 7), Value | 61);
    return ((Value ^ (Value >>> 14)) >>> 0) / 4294967296;
  };
  let Spare = /** @type {number | null} */ (null);
  const gaussian = () => {
    if (Spare !== null) {
      const Value = Spare;
      Spare = null;
      return Value;
    }
    let U = 0;
    while (U === 0) U = next();
    const V = next();
    const Radius = Math.sqrt(-2 * Math.log(U));
    Spare = Radius * Math.sin(2 * Math.PI * V);
    return Radius * Math.cos(2 * Math.PI * V);
  };
  return { next, gaussian };
}
