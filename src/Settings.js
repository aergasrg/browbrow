// User settings, saved on this device.

/** @typedef {import('./Signal/Methods.js').MethodName} MethodName */

/**
 * @typedef {object} SettingsValues
 * @property {MethodName} Method
 * @property {number} WindowSeconds
 * @property {string} CameraId Empty for the default front camera.
 * @property {number} MagnifyGain
 * @property {boolean} ShowMesh
 * @property {boolean} ShowZones
 * @property {boolean} ShowLabels
 * @property {boolean} ReduceMotion
 * @property {'Normal' | 'Pulse' | 'Magnify'} View
 * @property {boolean} RawWave
 */

const StorageKey = 'browbrow.pulse.settings.v1';

/** @type {SettingsValues} */
export const DefaultSettings = {
  Method: 'POS',
  WindowSeconds: 10,
  CameraId: '',
  MagnifyGain: 80,
  ShowMesh: true,
  ShowZones: true,
  ShowLabels: true,
  ReduceMotion: false,
  View: 'Normal',
  RawWave: false,
};

export class Settings {
  constructor() {
    /** @type {SettingsValues} */
    this.Values = { ...DefaultSettings, ...this.load() };
    /** @type {Set<(Values: SettingsValues, Changed: (keyof SettingsValues)[]) => void>} */
    this.Listeners = new Set();
  }

  /** @returns {Partial<SettingsValues>} */
  load() {
    try {
      const Saved = JSON.parse(localStorage.getItem(StorageKey) || '{}');
      /** @type {Partial<SettingsValues>} */
      const Clean = {};
      for (const Key of /** @type {(keyof SettingsValues)[]} */ (Object.keys(DefaultSettings))) {
        if (Key in Saved && typeof Saved[Key] === typeof DefaultSettings[Key]) /** @type {any} */ (Clean)[Key] = Saved[Key];
      }
      return Clean;
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(StorageKey, JSON.stringify(this.Values));
    } catch {
      // Private mode or storage blocked: settings just won't persist.
    }
  }

  /** @param {Partial<SettingsValues>} Changes */
  set(Changes) {
    const Changed = /** @type {(keyof SettingsValues)[]} */ (
      Object.keys(Changes).filter((Key) => /** @type {any} */ (this.Values)[Key] !== /** @type {any} */ (Changes)[Key])
    );
    if (!Changed.length) return;
    Object.assign(this.Values, Changes);
    this.save();
    for (const Listener of this.Listeners) Listener(this.Values, Changed);
  }

  /** @param {(Values: SettingsValues, Changed: (keyof SettingsValues)[]) => void} Listener */
  subscribe(Listener) {
    this.Listeners.add(Listener);
    return () => this.Listeners.delete(Listener);
  }
}
