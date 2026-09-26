// Camera access and a per-frame callback with accurate timestamps.

/**
 * @typedef {object} CameraInfo
 * @property {number} Width
 * @property {number} Height
 * @property {string} Label
 * @property {boolean} Mirrored True for a front camera (shown like a mirror).
 * @property {string} DeviceId
 */

/** @typedef {(TimeSeconds: number) => void} FrameCallback */

export class CameraError extends Error {
  /** @param {string} Message @param {'insecure' | 'denied' | 'missing' | 'busy' | 'unsupported' | 'unknown'} Kind */
  constructor(Message, Kind) {
    super(Message);
    this.Kind = Kind;
  }
}

export class CameraSource {
  /** @param {HTMLVideoElement} Video */
  constructor(Video) {
    this.Video = Video;
    /** @type {MediaStream | null} */
    this.Stream = null;
    /** @type {FrameCallback | null} */
    this.Callback = null;
    this.Running = false;
    this.Mirrored = true;
    this.LastVideoTime = -1;
    this.FrameHandle = 0;
  }

  /** @returns {Promise<{ DeviceId: string, Label: string }[]>} */
  static async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const Devices = await navigator.mediaDevices.enumerateDevices();
    return Devices.filter((Device) => Device.kind === 'videoinput').map((Device, Index) => ({
      DeviceId: Device.deviceId,
      Label: Device.label || `Camera ${Index + 1}`,
    }));
  }

  /**
   * @param {{ DeviceId?: string, Facing?: 'user' | 'environment', Width?: number, Height?: number }} [Options]
   * @returns {Promise<CameraInfo>}
   */
  async start(Options = {}) {
    if (!window.isSecureContext) {
      throw new CameraError('The camera only works over HTTPS. Open the https:// link.', 'insecure');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('This browser does not support camera access.', 'unsupported');
    }
    this.stop();
    /** @type {MediaTrackConstraints} */
    const Video = {
      width: { ideal: Options.Width ?? 640 },
      height: { ideal: Options.Height ?? 480 },
      frameRate: { ideal: 30, max: 30 },
    };
    if (Options.DeviceId) Video.deviceId = { exact: Options.DeviceId };
    else Video.facingMode = Options.Facing ?? 'user';
    try {
      this.Stream = await navigator.mediaDevices.getUserMedia({ video: Video, audio: false });
    } catch (Failure) {
      const Name = /** @type {Error} */ (Failure).name;
      if (Name === 'NotAllowedError' || Name === 'SecurityError') {
        throw new CameraError('Camera permission was denied.', 'denied');
      }
      if (Name === 'NotFoundError' || Name === 'OverconstrainedError') throw new CameraError('No camera was found.', 'missing');
      if (Name === 'NotReadableError' || Name === 'AbortError') throw new CameraError('The camera is being used by another app.', 'busy');
      throw new CameraError(/** @type {Error} */ (Failure).message || 'Could not start the camera.', 'unknown');
    }
    const Track = this.Stream.getVideoTracks()[0];
    const Settings = Track.getSettings();
    // Front cameras are shown mirrored; rear cameras are not.
    this.Mirrored = Settings.facingMode ? Settings.facingMode !== 'environment' : !/back|rear|environment/i.test(Track.label);
    this.Video.srcObject = this.Stream;
    this.Video.muted = true;
    this.Video.playsInline = true;
    await this.Video.play();
    if (!this.Video.videoWidth) {
      await new Promise((Resolve) => this.Video.addEventListener('loadedmetadata', Resolve, { once: true }));
    }
    return {
      Width: this.Video.videoWidth,
      Height: this.Video.videoHeight,
      Label: Track.label || 'Camera',
      Mirrored: this.Mirrored,
      DeviceId: Settings.deviceId ?? '',
    };
  }

  /**
   * Calls Callback once per new video frame with its capture time in seconds
   * (performance.now() clock).
   * @param {FrameCallback} Callback
   */
  onFrame(Callback) {
    this.Callback = Callback;
    this.Running = true;
    const Video = /** @type {HTMLVideoElement & { requestVideoFrameCallback?: Function }} */ (this.Video);
    if (typeof Video.requestVideoFrameCallback === 'function') {
      /** @param {number} Now @param {{ captureTime?: number, expectedDisplayTime?: number }} Metadata */
      const step = (Now, Metadata) => {
        if (!this.Running) return;
        // Ask for the next frame first so one failing frame can't stop the loop.
        this.FrameHandle = /** @type {any} */ (Video).requestVideoFrameCallback(step);
        const Time = (Metadata.captureTime || Metadata.expectedDisplayTime || Now) / 1000;
        this.deliver(Time);
      };
      this.FrameHandle = Video.requestVideoFrameCallback(step);
    } else {
      // Fallback: poll on animation frames and only report new video frames.
      const poll = () => {
        if (!this.Running) return;
        this.FrameHandle = requestAnimationFrame(poll);
        if (this.Video.currentTime !== this.LastVideoTime) {
          this.LastVideoTime = this.Video.currentTime;
          this.deliver(performance.now() / 1000);
        }
      };
      this.FrameHandle = requestAnimationFrame(poll);
    }
  }

  /** @param {number} Time */
  deliver(Time) {
    try {
      this.Callback?.(Time);
    } catch (Failure) {
      console.error('Frame processing failed', Failure);
    }
  }

  stop() {
    this.Running = false;
    const Video = /** @type {any} */ (this.Video);
    if (typeof Video.cancelVideoFrameCallback === 'function') Video.cancelVideoFrameCallback(this.FrameHandle);
    cancelAnimationFrame(this.FrameHandle);
    this.Stream?.getTracks().forEach((Track) => Track.stop());
    this.Stream = null;
    this.Video.srcObject = null;
  }
}

/** Keeps the screen on while measuring (a dimming screen also changes the lighting). */
export class ScreenWakeLock {
  constructor() {
    /** @type {any} */
    this.Lock = null;
    this.Wanted = false;
    document.addEventListener('visibilitychange', () => {
      if (this.Wanted && document.visibilityState === 'visible') this.acquire();
    });
  }

  async acquire() {
    this.Wanted = true;
    const WakeLockApi = /** @type {any} */ (navigator).wakeLock;
    if (!WakeLockApi || this.Lock) return;
    try {
      this.Lock = await WakeLockApi.request('screen');
      this.Lock.addEventListener('release', () => {
        this.Lock = null;
      });
    } catch {
      this.Lock = null; // Not allowed right now (battery saver, hidden tab); harmless.
    }
  }

  release() {
    this.Wanted = false;
    this.Lock?.release?.();
    this.Lock = null;
  }
}
