# browbrow pulse

**Your heart rate, read from your face.** Open it on your phone, look at the camera, and it measures your pulse from the tiny color change your skin goes through with every heartbeat. No watch, no finger on the lens. Everything runs in the browser, on your device.

The name finally makes sense: the **brow** (forehead) is the best place on your face to read a pulse.

> Not a medical device. Built for curiosity and learning.

## Try it

Once GitHub Pages is on (see below), open **https://aergasrg.github.io/browbrow/** in Safari on your iPhone (or any modern browser), tap **Start measuring**, and allow the camera. There's also a **Try the demo** button that runs on a simulated face with a known heart rate.

Tips for a good reading:

- Face a window or lamp. In a dark room, tap **Light** to turn the screen into a ring light (turn brightness all the way up).
- Hold still, relax your face, and breathe normally. The first number shows after about 7 seconds.
- In Safari, **Share → Add to Home Screen** installs it as a full-screen app.

### Turning on GitHub Pages

1. Merge this branch into `main`.
2. On GitHub, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, then **main** and **/ (root)**, and save.
4. After a minute the site is live at `https://aergasrg.github.io/browbrow/`.

The camera only works over HTTPS, which GitHub Pages provides. (Plain `http://192.168.x.x` addresses are blocked by iPhone Safari.)

## What's on screen

| Part | What it shows |
| --- | --- |
| **Camera view** | Face-lock brackets, the 478-point face mesh, and the three skin zones (forehead, left and right cheek), each tinted by its live signal quality. Chips for lighting, motion, distance, and frame rate tell you what to fix. |
| **View switcher** | **Normal**; **Pulse** (the face tints with each beat); **Magnify** (real Eulerian Video Magnification: your skin's actual color change amplified about 80× so you can see yourself flush with every heartbeat). |
| **Heart rate dial** | Big BPM number, a heart that beats on your *detected* heartbeats, a ring that shows calibration progress and then confidence, session min/avg/max, and trend. |
| **Pulse waveform** | A hospital-monitor sweep of your pulse, with a dot on every detected beat. **RGB** switches to the raw red/green/blue color change, in percent. |
| **Stat tiles** | Breathing rate (beta), HRV RMSSD with a Poincaré plot (beta), signal quality in dB, beat-to-beat interval with a tachogram, and session time. |
| **Frequency spectrum** | *Why this number*: the spectrum the heart rate is picked from, with the peak, its harmonic, and the bands that count as signal. |
| **Session trend** | Heart rate over the whole session, brighter where confidence was higher. |
| **Algorithm Lab** | The live pipeline (camera → face mesh → skin zones → color → algorithm → filter → FFT → BPM), and all three algorithms running side by side with an agreement meter. Tap one to make it drive the display. |
| **Verify** | Tap along with the pulse on your wrist; it compares your taps with the camera's number. |
| **Summary** | Stop to see the session summary and export CSVs: heart rate over time, or every raw skin-color sample so you can try your own algorithms. |

## How it works

1. **Track the face.** Google MediaPipe Face Landmarker finds 478 points on your face every frame, on the GPU. On slower devices it tracks every 2nd to 4th frame and reuses the landmarks in between, so skin sampling stays at full frame rate.
2. **Sample the skin.** The forehead and cheek zones are unions of face-mesh triangles, chosen geometrically on MediaPipe's canonical face (`tools/GenerateFaceGeometry.mjs`), so they stretch and turn with your face. Their average color is recorded every frame; blown-out and near-black pixels are skipped.
3. **Even out the timing.** Camera frames arrive irregularly, so the color traces are resampled to a steady 30 Hz.
4. **Extract the pulse.** Three published methods run side by side:
   - **POS** (Wang et al., 2017), the default. Projects the normalized color onto a plane orthogonal to the skin tone, which cancels brightness and glare changes.
   - **CHROM** (de Haan & Jeanne, 2013). Combines two chrominance signals to cancel motion.
   - **Green** (Verkruysse et al., 2008). The green channel alone; simple, and easily fooled by motion.
5. **Find the rhythm.** A zero-phase Butterworth band-pass (42–240 BPM), then a windowed, zero-padded FFT over the last 10 seconds. The peak is refined with parabolic interpolation, with a soft preference for continuity. Confidence comes from the SNR: power near the peak and its harmonic versus everything else.
6. **Beats, HRV, breathing.** Beats are peaks of the filtered waveform, confirmed once they're half a second old. HRV (RMSSD, SDNN) uses beat intervals with artifact rejection. Breathing combines the slight rise and fall of your head with the skin-brightness drift.
7. **Magnify.** Each frame is shrunk to 64 px, band-passed per pixel around your measured heart rate, blurred, amplified, and added back to the full-resolution video in a WebGL shader. The temporal filter is a continuous-time resonator stepped by each frame's real time gap, so uneven frame timing doesn't detune it.

## Accuracy and limits

- In good, even light while holding still, readings typically land within a few BPM. Use **Verify** to check yours.
- Motion and changing light are the main sources of error. POS and CHROM handle them far better than the green channel (the tests include a head-shake case that fools Green but not POS).
- Darker skin reflects less of the pulse signal, which is a known issue for all camera-based methods. Good light helps a lot, and POS and CHROM hold up better than Green. The tests cover a darker skin tone with half the pulse strength.
- Breathing rate and HRV are experimental. Camera timing (30 fps) limits HRV precision.

## Privacy

Video never leaves your device, and there are no analytics. The only downloads are the app's own files, the face model (served from this repo), and MediaPipe's code from the jsDelivr CDN. Settings are saved in your browser's local storage.

## Development

No build step and no runtime dependencies: it's plain JavaScript modules, type-checked with JSDoc.

```sh
python3 -m http.server 8000     # then open http://localhost:8000 (localhost is allowed to use the camera)
npm test                        # unit tests (Node 22+)
npm run typecheck               # strict type check of src/
npm run e2e                     # browser test in demo mode (needs: npm i -D playwright)
node tools/GenerateFaceGeometry.mjs --svg preview.svg   # regenerate the skin zones
```

Add `?demo` to the URL to start straight into demo mode.

The unit tests drive everything with a simulated face (`src/Sim/SyntheticSubject.js`) that has a known heart rate, breathing, lighting drift, and motion bursts. They check that each algorithm recovers the right rate, that beat times match the true heartbeats, that HRV and breathing come out right, and that the magnifier's filter works with uneven frame timing.

### Layout

```
index.html, styles/app.css     UI
src/App.js                     controller and frame loop
src/Signal/                    FFT, filters, resampler, POS/CHROM/Green, spectrum + SNR, beats + HRV, breathing, PulseEngine
src/Vision/                    MediaPipe wrapper, skin sampler, scene checks, generated face geometry
src/Magnify/                   Eulerian Video Magnification (WebGL) and the resonator filter
src/Camera/                    camera access, per-frame timestamps, wake lock
src/Ui/                        panels, charts, camera overlay, dialogs, start screen
src/Sim/                       simulated subject and demo face
tests/                         unit tests and the browser test
tools/                         face-geometry generator and MediaPipe's canonical face mesh
models/face_landmarker.task    MediaPipe Face Landmarker model
```

## Credits

- Face tracking: [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) by Google. The model (`models/face_landmarker.task`) and the canonical face mesh (`tools/data/canonical_face_model.obj`) are from MediaPipe, Apache License 2.0.
- W. Wang, A. C. den Brinker, S. Stuijk, G. de Haan. *Algorithmic Principles of Remote PPG.* IEEE TBME, 2017. (POS)
- G. de Haan, V. Jeanne. *Robust Pulse Rate From Chrominance-Based rPPG.* IEEE TBME, 2013. (CHROM)
- W. Verkruysse, L. O. Svaasand, J. S. Nelson. *Remote plethysmographic imaging using ambient light.* Optics Express, 2008.
- H.-Y. Wu, M. Rubinstein, E. Shih, J. Guttag, F. Durand, W. Freeman. *Eulerian Video Magnification for Revealing Subtle Changes in the World.* SIGGRAPH, 2012.
