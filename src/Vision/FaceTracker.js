// MediaPipe Face Landmarker wrapper: 478 face landmarks per video frame,
// running on the GPU in the browser. Nothing leaves the device.

const MediaPipeVersion = '1.0.1';
const DefaultMediaPipeBase = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MediaPipeVersion}`;
const DefaultModelUrl = new URL('../../models/face_landmarker.task', import.meta.url).href;

/**
 * Where to load MediaPipe from. Tests can point this at a same-origin copy
 * with ?mediapipe=/path; other origins are ignored so a crafted link cannot
 * load foreign code into a page that has camera access.
 */
function mediaPipeBase() {
  const Override = new URLSearchParams(location.search).get('mediapipe');
  if (Override) {
    const Resolved = new URL(Override, location.href);
    if (Resolved.origin === location.origin) return Resolved.href.replace(/\/$/, '');
  }
  return DefaultMediaPipeBase;
}

/**
 * Downloads a file, reporting progress 0..1.
 * @param {string} Url
 * @param {(Fraction: number) => void} onProgress
 */
async function fetchWithProgress(Url, onProgress) {
  const Response = await fetch(Url);
  if (!Response.ok) throw new Error(`Could not download ${Url} (${Response.status})`);
  const Total = Number(Response.headers.get('content-length')) || 0;
  if (!Response.body || !Total) {
    const Buffer = new Uint8Array(await Response.arrayBuffer());
    onProgress(1);
    return Buffer;
  }
  const Reader = Response.body.getReader();
  const Result = new Uint8Array(Total);
  let Received = 0;
  for (;;) {
    const { done: Done, value: Chunk } = await Reader.read();
    if (Done) break;
    if (Received + Chunk.length > Result.length) {
      // Server sent more than it announced (compression); fall back to growing.
      const Grown = new Uint8Array(Math.max(Result.length * 2, Received + Chunk.length));
      Grown.set(Result.subarray(0, Received));
      return finishGrowing(Reader, Grown, Received, Chunk, onProgress);
    }
    Result.set(Chunk, Received);
    Received += Chunk.length;
    onProgress(Math.min(1, Received / Total));
  }
  return Result.subarray(0, Received);
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} Reader
 * @param {Uint8Array} Buffer
 * @param {number} Received
 * @param {Uint8Array} Pending
 * @param {(Fraction: number) => void} onProgress
 */
async function finishGrowing(Reader, Buffer, Received, Pending, onProgress) {
  let Result = Buffer;
  let Size = Received;
  /** @param {Uint8Array} Chunk */
  const append = (Chunk) => {
    if (Size + Chunk.length > Result.length) {
      const Grown = new Uint8Array(Math.max(Result.length * 2, Size + Chunk.length));
      Grown.set(Result.subarray(0, Size));
      Result = Grown;
    }
    Result.set(Chunk, Size);
    Size += Chunk.length;
  };
  append(Pending);
  for (;;) {
    const { done: Done, value: Chunk } = await Reader.read();
    if (Done) break;
    append(Chunk);
  }
  onProgress(1);
  return Result.subarray(0, Size);
}

export class FaceTracker {
  /**
   * @param {any} Landmarker MediaPipe FaceLandmarker instance.
   * @param {'GPU' | 'CPU'} Delegate
   */
  constructor(Landmarker, Delegate) {
    this.Landmarker = Landmarker;
    this.Delegate = Delegate;
    this.Points = new Float32Array(478 * 2);
    this.LastTimestamp = -1;
    this.LastDetectMs = 0;
  }

  /**
   * Loads MediaPipe and the model.
   * @param {(Stage: string, Fraction: number) => void} onProgress
   */
  static async create(onProgress = () => {}) {
    const Base = mediaPipeBase();
    onProgress('Loading face tracker', 0);
    const [Vision, Model] = await Promise.all([
      import(/* @vite-ignore */ `${Base}/vision_bundle.mjs`),
      fetchWithProgress(DefaultModelUrl, (Fraction) => onProgress('Downloading face model', Fraction)),
    ]);
    onProgress('Starting face tracker', 1);
    const Fileset = await Vision.FilesetResolver.forVisionTasks(`${Base}/wasm`);
    /** @param {'GPU' | 'CPU'} Delegate */
    const build = (Delegate) =>
      Vision.FaceLandmarker.createFromOptions(Fileset, {
        baseOptions: { modelAssetBuffer: Model, delegate: Delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    try {
      return new FaceTracker(await build('GPU'), 'GPU');
    } catch (GpuError) {
      console.warn('GPU face tracking unavailable, using CPU', GpuError);
      return new FaceTracker(await build('CPU'), 'CPU');
    }
  }

  /**
   * Landmarks for the current video frame, or null if no face.
   * @param {HTMLVideoElement} Video
   * @param {number} TimestampMs Must increase between calls.
   * @returns {Float32Array | null} Normalized [x0, y0, ...], 478 points.
   */
  detect(Video, TimestampMs) {
    const Timestamp = Math.max(TimestampMs, this.LastTimestamp + 1);
    this.LastTimestamp = Timestamp;
    const Started = performance.now();
    const Result = this.Landmarker.detectForVideo(Video, Timestamp);
    this.LastDetectMs = performance.now() - Started;
    const Face = Result && Result.faceLandmarks && Result.faceLandmarks[0];
    if (!Face || Face.length < 468) return null;
    const Count = Math.min(478, Face.length);
    for (let Index = 0; Index < Count; Index++) {
      this.Points[Index * 2] = Face[Index].x;
      this.Points[Index * 2 + 1] = Face[Index].y;
    }
    return this.Points;
  }

  close() {
    this.Landmarker?.close?.();
  }
}
