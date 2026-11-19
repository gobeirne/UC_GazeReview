# Gaze review

A browser tool for reviewing where a student is looking during a recorded online exam (for example a Respondus Monitor webcam video). It tracks the face and eyes in every frame, projects gaze onto a plane centred on the camera, and shows where the student's attention goes over time: the laptop screen, notes on the desk, a phone on a stand.

It is a review aid. It does the job of keeping track of where "screen" and "phone" are for this student and points to the moments when gaze goes there. Every glance it lists should be checked by eye in the video. It does not decide whether anything is misconduct.

Everything runs in the browser. Video is never uploaded, and only measurements are saved.

---

## Quick start

```bash
npm install          # also copies MediaPipe WASM and downloads the face model into public/
npm run dev          # http://localhost:5173
npm test             # demuxer, intervals, gaze model, events, capture alignment
npm run build        # static site in dist/
```

If `npm install` could not download the model, run `npm run setup` later. Without the bundled model the app downloads it from Google at runtime and won't work offline.

## Deploying

There is no application server: `dist/` is the whole app.

**GitHub Pages:** push to `main`. `.github/workflows/deploy.yml` installs, fetches the model, runs the tests, builds and publishes. In the repository, set *Settings › Pages › Source* to *GitHub Actions*.

**Other static hosting:** run `npm run setup && npm run build` and upload the contents of `dist/`. Serve `.wasm` as `application/wasm` and don't long-cache `sw.js`.

---

## Using it

### Opening a recording

- **Video file:** *Open video file…* and choose the WebM. The file is indexed in a few seconds, then plays in the left panel.
- **Screen capture:** if the video can only be watched in a player (for example inside the LMS), use *Capture from screen…*, choose the browser tab or window, drag a box around the student's video, type the time the player is showing and press *Start analysing*. Play the video at normal speed and at least at its original size. Stop when done.

Each recording is saved in this browser under its own name. Video files are recognised by content, so opening the same file later brings back everything done so far.

### Segments

Add the parts of the exam you want to look at (*From*, *to*, optional label; *Now* takes the current playback time). Each segment is analysed once. A new segment that overlaps earlier ones only analyses the part not already done, and removing a segment deletes the frames no other segment still covers.

The strip across the top of the timeline shows the whole recording: segments above, analysed parts shaded. Click a segment there or press *Show* to look at that segment alone.

### The gaze plane

The plane is the view from the camera: the video sits at the camera position, the student's right is on the left of the plane and up is up. Each frame's gaze is a point in degrees from the camera.

- The **heatmap** shows where gaze spent time in the current segment (or all of them).
- The **trail** shows the last 2 s up to the playback position.
- The dashed **circle** is the centre of the main on-screen cluster found by the model.
- **Drag** to highlight the times when gaze was inside the box; they are marked along the top of the timeline.

### Labelling what the student looks at

Choose *click a hotspot or drag a box to label it*, then either click on a busy part of the heatmap (the hotspot around it is outlined automatically) or drag a box. Pick what it is — laptop screen, phone, paper, second screen, keyboard, another person, thinking — or type a name. One region can be marked as *the screen*; everything else counts as looking away.

A *Laptop screen* region is created automatically the first time a recording is analysed, from the main cluster. Regions can be renamed, re-marked or adjusted by typing their edges in degrees.

### Timeline

Horizontal and vertical gaze against time, in the style of a VNG trace, with the screen centre as a dashed line. Below them the *where* band colours each frame by region (orange for off-screen but unlabelled, grey for no gaze), and black bars mark the listed glances.

Click to go to a moment, drag to highlight a stretch (its points are shown on the plane), scroll to zoom.

### Glances away

Every stretch of two or more frames off the screen, with start time, length, where it went and how far from the screen centre. Click one to go to just before it. **N** and **P** step through them.

*Lids: narrowed* means the eyelids closed to under 60% of the student's usual opening during the glance. Blinks and looks down both do this, and a look down can register as a short vertical excursion, so check these ones carefully.

### Keyboard

Space play/pause · ← → one frame (Shift: ten) · N / P next or previous glance · Esc clear highlights.

### Saving and moving work

Everything is saved in this browser automatically. *Export* writes one JSON file per recording (segments, regions, settings and per-frame measurements, no video) and *Import* reads it back, on this or another computer. Clearing the browser's site data deletes saved work, so export anything you need to keep.

---

## How it works

### Reading the video

`src/video/webm.ts` walks the WebM file once and builds an index of every video frame (timestamp, byte range, keyframe). Browser-recorded WebM often has no seek index, unknown-size elements and sometimes no duration; the walk copes with all of these. Analysis decodes frames with WebCodecs from the keyframe before each stretch, runs a 1 s lead-in through the tracker so it has settled, and keeps frames from the requested start onwards.

### Measuring each frame

The face tracker and feature extraction come from UC_TFR (`src/tracking/`): MediaPipe Face Landmarker gives head orientation (relative to the face-to-camera line, so moving in the seat doesn't count as turning), the model's per-eye gaze estimates (blendshapes), iris position within each eye, blink scores and lid opening. All of it is stored per frame, with a 16×12 thumbnail fingerprint used to align screen captures.

### From head and eyes to gaze

```
gazeH = sH·headH + kH·eyeH        gazeV = sV·headV + kV·eyeV
```

- **sH, sV** fix the tracker's head-angle sign conventions, from the correlation with the nose position in the image.
- **k** converts the eye measure to degrees. While the student reads the screen, head movements are offset by opposite eye movements, so within the screen cluster `eye = (target − head)/k`. The fit regresses eye on head, `k = −var(head)/cov(eye, head)`. Regressing head on eye instead would be biased towards zero by how much the reading position moves around the screen. The fitted value is used when there are at least 200 on-screen frames, |r| > 0.3 and it lies within 0.4–2.5 times the prior. Otherwise the prior is used, and the model panel says why. Priors are 40°/unit for the face model's estimate (as in UC_TFR) and 140°/unit for iris position (about a 12 mm eyeball radius against a 30 mm eye width). Both scales can be set by hand.
- **The screen** is the densest region of a smoothed 1° histogram of gaze, with frames within 12° of it treated as on-screen while fitting.
- **Posture drift** is followed by re-centring on the median of on-screen frames over a moving window (60 s by default), so slumping or a nudged laptop lid doesn't move the clusters.
- **Blinks**: the last eye position is held for up to 300 ms while an eye is closed.

The fitting is repeated whenever segments are added, using the saved measurements; the face tracker is not re-run.

### Glances

Frames are labelled by region (non-screen regions win where regions overlap). A glance is a run of frames not on the screen, at least *Shortest glance listed* frames long (2 by default), bridging up to 2 frames without gaze. A gap in the data always ends one.

### Screen capture timing

The player's clock can't be read, so capture time is the typed start time plus wall-clock time between new source frames. Repeated captures of the same source frame are skipped, and any pause longer than 400 ms adds only 400 ms, so a paused or buffering player doesn't push the estimate ahead.

When a capture overlaps frames already analysed, its thumbnails are matched against the stored ones over ±8 s. If the match is clear, the capture's times are corrected and only the new part is kept. If not, the capture is kept as its own segment marked *times approximate* and nothing is merged.

---

## Limits

- **Size of eye movements.** At 640×480 the iris is about 13–15 px across and the eye about 30–35 px wide. Frame-to-frame noise is about 1.5–2°, with slow drift between the two eyes of up to about 7°. Glances needing 15° or more of eye rotation stand out clearly; movements under about 5° are not distinguishable from drift. Glasses glare and poor light make this worse.
- **Compression.** Heavily compressed video may not encode very small eye movements at all between keyframes.
- **Blinks and looks down** both narrow the lids and can look alike. Check glances marked *narrowed*.
- **Unusual eyes.** Strabismus, nystagmus and similar conditions produce patterns that are not glances. A heatmap with two overlapping screen clusters, or a constantly moving trace, is a reason to rely on the video alone.
- **Formats.** WebM (VP8, VP9, AV1) is supported for files; other formats can be reviewed through screen capture. Frame-by-frame decoding needs WebCodecs (current Chrome, Edge, Firefox or Safari).
- **Speed.** Analysis runs the face model on every frame. It is much faster with a GPU; in a software-only graphics environment it ran at about 3 frames/s.

## Privacy

- Video is read from the file (or the captured window) in the page and is never uploaded, recorded or cached. The service worker caches only the app's own files and the model.
- Saved data per recording: segments, regions, settings, per-frame numbers and 16×12 greyscale thumbnails, kept in this browser's IndexedDB until deleted.
- MediaPipe Tasks sends usage metrics (not images) to `odml.pa.googleapis.com` by default. The page's Content-Security-Policy blocks all network connections except the app's own origin and Google's model host, so those metrics are not sent. The model host is only contacted if the bundled model is missing.
- No login, analytics or telemetry.

## Code

| Path | Contents |
|---|---|
| `src/tracking/` | Copied from UC_TFR. `MediaPipeFaceTracker.ts` accepts decoded frames as well as video elements; the others are unchanged. |
| `src/video/` | WebM index and WebCodecs analysis of a time stretch |
| `src/capture/` | Screen/window capture, time estimation and alignment |
| `src/analysis/` | Interval sets, per-frame measurement, gaze model, regions and glances |
| `src/store/` | Data types, IndexedDB storage, export and import |
| `src/ui/` | App, gaze plane, timeline |
| `tests/` | Unit tests (synthetic WebM, simulated gaze, capture alignment) |

Licence: MPL 2.0, as UC_TFR.
