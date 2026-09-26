// In-place iterative radix-2 FFT with cached twiddle and bit-reversal tables.

export class Fft {
  /** @param {number} Size Power of two. */
  constructor(Size) {
    if (Size < 2 || (Size & (Size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${Size}`);
    this.Size = Size;
    this.Cos = new Float64Array(Size / 2);
    this.Sin = new Float64Array(Size / 2);
    for (let Index = 0; Index < Size / 2; Index++) {
      this.Cos[Index] = Math.cos((2 * Math.PI * Index) / Size);
      this.Sin[Index] = Math.sin((2 * Math.PI * Index) / Size);
    }
    this.Reversed = new Uint32Array(Size);
    const Bits = Math.log2(Size);
    for (let Index = 0; Index < Size; Index++) {
      let Value = Index;
      let Result = 0;
      for (let Bit = 0; Bit < Bits; Bit++) {
        Result = (Result << 1) | (Value & 1);
        Value >>= 1;
      }
      this.Reversed[Index] = Result;
    }
  }

  /**
   * Transforms (Re, Im) in place. The inverse transform includes the 1/N scale.
   * @param {Float64Array} Re
   * @param {Float64Array} Im
   * @param {boolean} [Inverse]
   */
  transform(Re, Im, Inverse = false) {
    const Size = this.Size;
    if (Re.length !== Size || Im.length !== Size) throw new Error('FFT input length mismatch');
    for (let Index = 0; Index < Size; Index++) {
      const Target = this.Reversed[Index];
      if (Target > Index) {
        let Swap = Re[Index];
        Re[Index] = Re[Target];
        Re[Target] = Swap;
        Swap = Im[Index];
        Im[Index] = Im[Target];
        Im[Target] = Swap;
      }
    }
    const Sign = Inverse ? 1 : -1;
    for (let Span = 2; Span <= Size; Span <<= 1) {
      const Half = Span >> 1;
      const Step = Size / Span;
      for (let Start = 0; Start < Size; Start += Span) {
        for (let Offset = 0; Offset < Half; Offset++) {
          const TwiddleRe = this.Cos[Offset * Step];
          const TwiddleIm = Sign * this.Sin[Offset * Step];
          const Even = Start + Offset;
          const Odd = Even + Half;
          const OddRe = Re[Odd] * TwiddleRe - Im[Odd] * TwiddleIm;
          const OddIm = Re[Odd] * TwiddleIm + Im[Odd] * TwiddleRe;
          Re[Odd] = Re[Even] - OddRe;
          Im[Odd] = Im[Even] - OddIm;
          Re[Even] += OddRe;
          Im[Even] += OddIm;
        }
      }
    }
    if (Inverse) {
      for (let Index = 0; Index < Size; Index++) {
        Re[Index] /= Size;
        Im[Index] /= Size;
      }
    }
  }
}

/** @type {Map<number, Fft>} */
const Cache = new Map();

/** Shared FFT instance for a size. @param {number} Size */
export function getFft(Size) {
  let Instance = Cache.get(Size);
  if (!Instance) {
    Instance = new Fft(Size);
    Cache.set(Size, Instance);
  }
  return Instance;
}

/** @param {number} Value */
export function nextPowerOfTwo(Value) {
  let Result = 1;
  while (Result < Value) Result <<= 1;
  return Result;
}
