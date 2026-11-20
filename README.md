# Gaze review

A browser tool for reviewing where a person in a webcam video is looking. It tracks the face and eyes in every frame, projects gaze onto a plane centred on the camera, and shows where their attention goes over time: the laptop screen, notes on the desk, a phone on a stand. Timestamped events, such as saved responses from a response-history timeline, can be shown against the video, and a second recording (for example of the screen) can play alongside in step.

It is a review aid. It keeps track of where each place is for this person and points to the moments when gaze goes there. Every look it lists should be checked by eye in the video; it doesn't interpret them.

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
- **Screen capture:** if the video can only be watched in a player (for example inside a web page), use *Capture from screen…*, choose the browser tab or window, drag a box around the video, type the time the player is showing and press *Start analysing*. Play the video at normal speed and at least at its original size. Stop when done.

Each recording is saved in this browser under its own name. Video files are recognised by content, so opening the same file later brings back everything done so far.

### Playing the video

The video plays with sound (*Sound on/off* and the volume slider; the choice is remembered). Buttons jump back or forward 10 s, 5 s or one frame; speeds run from ¼× to 2×.

With *Track gaze live during playback* on, every frame shown is run through the face tracker as it plays, analysed or not, so you can compare what you see with where the tool puts the gaze. Under the video a readout gives the region at that moment and how far the gaze is from the screen centre ("12° to their right, 6° down"), and says whether this comes from the saved analysis or was tracked live. On the plane, live positions are drawn as a dashed amber trail with a ring.

Live frames use the model fitted from the saved segments (eye scale, head signs and the nearest drift correction). Before any segment is analysed they use the default eye scale, so positions are approximate. Live frames are never saved; add a segment to keep them.

*Show tracked eyes on the video* draws the eye outlines and iris circles the tracker found on the current frame, as a check that it is following the eyes and not, for example, a reflection in glasses.

On a slow computer live tracking can make playback stutter; turn it off, or use ½× speed.

### Segments

Add the parts of the video you want to look at (*From*, *to*, optional label; *Now* takes the current playback time). Each segment is analysed once. A new segment that overlaps earlier ones only analyses the part not already done, and removing a segment deletes the frames no other segment still covers.

*Fill gaps* analyses again only the stretches of a segment where the face wasn't tracked (at least 0.5 s long; stretches less than 5 s apart are done together, since each needs a seek and a 1 s lead-in) and keeps every frame that has gaze. *Re-analyse* discards all of a segment's results and analyses it again. Both keep regions.

Analysis is saved as it goes, every 30 s of video. *Stop* keeps everything analysed up to that moment, and *Analyse* on the segment carries on from there, so nothing is lost by stopping or by closing the page mid-analysis (at most the last 30 s if the page is closed).

The strip across the top of the timeline shows the whole recording: segments above, analysed parts shaded. Click a segment there or press *Show* to look at that segment alone.

### The gaze plane

The plane is the view from the camera: the video sits at the camera position, the person's right is on the left of the plane and up is up. Each frame's gaze is a point in degrees from the camera.

- The **heatmap** shows where gaze spent time. *Heatmap of* chooses which frames: the segment shown (or all segments), only the stretch highlighted on the timeline, or nothing.
- The **trail** shows the last 2 s up to the playback position.
- The dashed **circle** is the centre of the main on-screen cluster found by the model.
- **Drag** to highlight the times when gaze was inside the box; they are marked along the top of the timeline.

### Labelling what the person looks at

Regions name the places the person looks: laptop screen, phone, paper, second screen, keyboard, another person, thinking, or any name you type. One region can be marked as *the screen*; everything else counts as looking away. A *Laptop screen* region is created automatically from the main cluster once there are 10 s of on-screen frames, and is refitted as more is analysed until you edit it.

To add one:

- **While watching:** when you see her look at something, press **L** or *Label where they’re looking now*. The video pauses and a box is proposed around where her gaze was over the surrounding 0.4 s (from the saved analysis, or live tracking if this moment isn’t analysed). Pick a name and add it.
- **On the plane:** choose *label and edit regions*, then click a busy part of the heatmap (the hotspot around it is outlined automatically) or drag a box.

To change one, in *label and edit regions* mode: click a region to rename it, mark or unmark it as the screen, or delete it (or press Delete). Drag inside it to move it, or drag its edges and corners to resize it. The regions table under the timeline also lets you rename them and type their edges in degrees. Glance lists and timings update as soon as a region changes.

### Timeline

Horizontal and vertical gaze against time, in the style of a VNG trace, with the screen centre as a dashed line. Below them the *where* band colours each frame by region (orange for off-screen but unlabelled, grey for no gaze), and black bars mark the listed glances.

Click to go to a moment, drag to highlight a stretch (its points are shown on the plane), scroll to zoom.

### Glances away

Every stretch of two or more frames off the screen, with start time, length, where it went and how far from the screen centre. Click one to go to just before it. **N** and **P** step through them.

*Lids: narrowed* means the eyelids closed to under 60% of the person's usual opening during the glance. Looks down do this, and so can a blink the blink filter didn't catch, so check these ones carefully.

### Blinks

As the lids close, the face model's eye estimate drops, which shows as a brief downward dip and can be listed as a glance. With *Remove blinks from the eye trace* on (the default), a stretch where the lids are below 70% of the person's usual opening for no more than 400 ms, plus one frame either side, has its eye movement replaced by a straight line from the frame before to the frame after. Longer lid dips are kept, because looking down at the desk lowers the lids too. Removed blinks are marked by a dark line along the top of the *where* band, and the count is shown in the model panel. Both numbers can be changed in the gaze model settings. During live playback, which can't look ahead, a blink holds the last eye position instead.

### Keyboard

Space play/pause · ← → one frame (Shift: ten) · N / P next or previous glance · L label where they're looking · Delete remove the selected region · Esc clear highlights and close the region form.

### Event timeline

The *Event timeline* panel attaches timestamped events to the recording and shows them against the video. It reads the response-history timeline format `moodle-quiz-response-timeline/v1` (JSON, as made by the standalone timeline processor), or the saved HTML source of a Moodle attempt review page with its response histories, which it converts to the same format. Paste the source, or import the file. The events are kept exactly as imported.

**Lining up.** Event times are wall-clock times; video times start at zero. Enter the clock time at which the video started (*The video started at*, to the second), then nudge it in steps of 1 s, 10 s or 1 min until events line up with what you see. Alternatively, play to the moment an event happens, choose that event and press *this event happens here*. The video file's own date header can be used as a starting point, but it may record when the file was processed rather than when recording began, so check it. Events aren't placed on the video until a start time is set, and the method used is kept with the recording, with an optional note. Times are compared as plain clock times, so time zones and daylight saving don't affect the placing, provided both times are read in the same time zone.

**What's shown.**

- Coloured marks on the whole-recording strip and an *events* lane on the timeline, labelled with the item number: blue for a first save, orange for a changed response, grey for the same response saved again.
- A list of events with video time, clock time, item, saved response, the change (e.g. C → A), and the most recent look away in the minute before it. Clicking an event goes to 10 s before it.
- The most recent event in the readout under the video during playback.
- *Looks away around events*: looks away starting in each 5 s bin from 60 s before to 10 s after each event, for events whose window has been analysed. A line and band show the same looks with the events placed at random in the analysed video (mean and 95% range of 500 shuffles), so it shows whether looks cluster before events more than chance gives. It can count looks anywhere off screen or to one region.

The panel's main result counts **events**, not looks: how many events had at least one look in the 10 s before, against the same count for randomly placed events, with a p value (the share of 500 random placements that did at least as well). Looks often come in bursts, so counting looks lets one event with several glances count several times, which widens the chance range; counting events avoids that. The look count is shown as well.

*Window before saves* sets how far before each save a look counts (5–30 s; 10 s by default). Choose it from what you've seen in the video before looking at the result. Saves less than 2 s apart (several items saved by one page, or a final submit) count as one moment, so the same looks aren't counted several times; in the raster they share a row labelled with all their items.

**Where in each item the looks fall.** The panel also reports a test that needs no window: each item runs from the previous save to its own, a look's position is how far through the item it starts (0 to 1), and each item with looks contributes the median position of its looks. If looks had nothing to do with answering, about half the items would have that value past halfway; a one-sided sign test gives the p value. Only items analysed from start to end are used. The figure's item-by-item panel shows the positions as a histogram under the staircase.

*Count each look once, within the timeline* (on by default) counts a look only for the item being answered when it happened: from the previous save to this one, not also in the next item's minute. It also keeps the chance comparison and panel B's heatmap to the timeline's span (from its start to its finish), so other parts of the recording, such as before the timeline starts, don't affect them.

*Looks formed* chooses how looks are made for this analysis. *As away from the screen* (the default) uses the looks listed in *Glances away*. *As stretches, by most frames* is how the first exported figures counted: every region is treated as an ordinary region, so a look is a stretch outside the main on-screen cluster, credited to the region it spends most frames in, and brief crossings into a region don't count separately. *with at least … frames in the region* keeps only looks with that many frames inside the chosen region.

*lasting at least* leaves out looks shorter than a chosen length (0.1–1 s), so brief crossings of a region's edge (a few frames, often noise near the screen's edge) can be separated from sustained looks. In the exported raster each look is drawn as a bar as long as the look, so the two kinds can be told apart by eye. Choose the length for a reason other than the result (for example, from how long the looks you can see in the video last), or the p value loses its meaning.

**Exports** (below the histogram), for the region chosen in *Count looks to*:

- *Export figure (PNG)*: a print-resolution figure for email or documents. *Panel A* can show the items one by one against time (each row the time from the previous save to this one, with looks during it; answering in order makes a staircase), or a raster (one row per event, a tick for each look, aligned to the event) above the histogram with its chance band; panel B is the gaze plane with the labelled regions and the share of time at each. The caption states the result.
- *Export report (HTML)*: one self-contained file that prints to PDF: the result, a summary, the figure, looks and time per region, the event table with the time since the last look to each region, how the timeline was lined up, the method and the limits.
- *Export responses (CSV)*: the event table for your own analysis.

Item wording and saved responses are left out unless *Include item wording and responses* is ticked. No video frames are included in any export.

A saved response marks when the response was submitted (usually on moving to the next page, or an autosave), not when it was chosen, so looks connected with it come before the mark.

### A second synchronised video

*Add another synchronised video…* opens a second recording, such as a screen recording, in its own window. It plays, pauses, seeks and changes speed with the main video. Its starting offset is taken from the two files' date headers when both have one (check it), and can be adjusted in 1 s and 0.1 s steps in its window; the offset is saved with the recording. Sound is off in the second window unless turned on there. If the browser blocks the window, allow pop-ups for the page.

### Saving and moving work

Everything is saved in this browser automatically (IndexedDB), and opening the same video again brings it back. That store belongs to this browser on this computer, and clearing the browser's site data deletes it.

**Saving next to the videos (Chrome and Edge).** *Save to a folder…* links a folder, normally the one holding the videos. Each recording is then also kept there as `<video name>.gaze.json`, updated during analysis and after every change. Opening a video picks up its file from the folder if it is newer than this browser's copy, so work carries over to another computer or browser with the folder. The menu beside the button lists the videos in the folder, with ✓ against those that have saved analysis. Browsers ask for permission to the folder again in each new session; the button then reads *Reconnect*. Deleting a recording in the tool doesn't delete its file in the folder.

**Export and Import** write and read the same file by hand, for browsers without folder access or for sending to someone with the video. The export can leave out the event timeline's item wording and saved responses, and the 16×12 frame thumbnails, which are only needed to line up later screen captures: the file is then about a third of the size and holds no image-derived data. Treat either version as you would the recording itself.

### Several videos at once

Each video can be open in its own window, and analyses in hidden tabs and minimised windows keep running at full speed. They share the computer's GPU, so two analyses at once each run slower. A video can only be open in one window at a time; the second window says so instead of opening it.

---

## How it works

### Reading the video

`src/video/webm.ts` walks the WebM file once and builds an index of every video frame (timestamp, byte range, keyframe). Browser-recorded WebM often has no seek index, unknown-size elements and sometimes no duration; the walk copes with all of these. Analysis decodes frames with WebCodecs from the keyframe before each stretch, runs a 1 s lead-in through the tracker so it has settled, and keeps frames from the requested start onwards.

### Measuring each frame

The face tracker and feature extraction come from UC_TFR (`src/tracking/`): MediaPipe Face Landmarker gives head orientation (relative to the face-to-camera line, so moving in the seat doesn't count as turning), the model's per-eye gaze estimates (blendshapes), iris position within each eye, blink scores and lid opening. All of it is stored per frame, with a 16×12 thumbnail fingerprint used to align screen captures.

Laptop webcam recordings are often dim and low, with the chin or forehead out of the picture, so each frame is prepared before tracking (`src/video/prepare.ts`):

- **Padding.** The frame is drawn with a grey border of 15% on every side, because the face detector misses faces that run off the edge of the picture. Landmarks are mapped back to the original frame, and the head-pose translation is rescaled to undo the padding's effect on the pose model's assumed field of view.
- **Brightening.** Frames with a mean grey level below 95/255 are brightened towards 120 (at most 2.2×) with slightly more contrast.
- **Only the eyes must be in frame.** UC_TFR rejects a face if its forehead, chin, sides or nose touch the edge; here only the eye corners and irises must be inside the frame.
- **Lower thresholds.** Face detection, presence and tracking confidence are 0.3, 0.4 and 0.4 (UC_TFR uses 0.5, 0.6 and 0.6), so dim or partly hidden faces are kept rather than dropped.

The model panel reports why frames have no gaze (no face found, eyes out of frame, eyes closed or not measurable) and how many frames were brightened. On a test clip with the chin cut off and the picture darkened, gaze was available in 1% of frames with UC_TFR's settings and 100% with these.

### From head and eyes to gaze

```
gazeH = sH·headH + kH·eyeH        gazeV = sV·headV + kV·eyeV
```

- **sH, sV** fix the tracker's head-angle sign conventions, from the correlation with the nose position in the image.
- **k** converts the eye measure to degrees. While the person reads the screen, head movements are offset by opposite eye movements, so within the screen cluster `eye = (target − head)/k`. The fit regresses eye on head, `k = −var(head)/cov(eye, head)`. Regressing head on eye instead would be biased towards zero by how much the reading position moves around the screen. The fitted value is used when there are at least 200 on-screen frames, |r| > 0.3 and it lies within 0.4–2.5 times the prior. Otherwise the prior is used, and the model panel says why. Priors are 40°/unit for the face model's estimate (as in UC_TFR) and 140°/unit for iris position (about a 12 mm eyeball radius against a 30 mm eye width). Both scales can be set by hand.
- **The screen** is the densest region of a smoothed 1° histogram of gaze, with frames within 12° of it treated as on-screen while fitting.
- **Distance from the camera.** Angles to things near the camera widen as the person leans in: a phone 20 cm to the side of the camera is 18° away at 60 cm but 39° at 25 cm. The head-pose model gives the face-to-camera distance in each frame, and each gaze angle is rescaled to what it would be from the person's usual (median) distance: `atan(tan(angle) × distance / usual distance)`. This keeps the screen, a phone and notes in the same place on the plane however far forward they lean. It assumes those things lie roughly in a plane through the camera facing the person, which suits a laptop screen and things beside it; notes flat on the desk close to the person fit less well. It can be turned off in the gaze model settings, and the panel shows the range of distances seen. Frames analysed before distances were recorded aren't corrected; *Re-analyse* fixes that.
- **Posture drift** is followed by re-centring on the median of on-screen frames over a moving window (60 s by default), so slumping, moving in the seat or a nudged laptop lid doesn't move the clusters. Where a stretch has too few on-screen frames, the nearest stretch that has them is used. Head direction is measured relative to the line from the face to the camera, so moving around the frame without turning doesn't count as looking elsewhere.
- **Blinks** are removed as described above. Where the eyes can't be measured at all, the last eye position is held for up to 300 ms.

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
- **Blinks and looks down** both narrow the lids. The blink filter separates them by duration only, so a very quick glance down (under 400 ms, with the lids dropping below 70%) can be removed as a blink. Turn the filter off, or shorten its limit, when checking for quick looks at the desk.
- **Unusual eyes.** Strabismus, nystagmus and similar conditions produce patterns that are not glances. A heatmap with two overlapping screen clusters, or a constantly moving trace, is a reason to rely on the video alone.
- **Formats.** WebM (VP8, VP9, AV1) is supported for files; other formats can be reviewed through screen capture. Frame-by-frame decoding needs WebCodecs (current Chrome, Edge, Firefox or Safari).
- **Speed.** Analysis runs the face model on every frame. It is much faster with a GPU; in a software-only graphics environment it ran at about 3 frames/s.

## Privacy

- Video is read from the file (or the captured window) in the page and is never uploaded, recorded or cached. Live tracking during playback is not saved. The service worker caches only the app's own files and the model.
- Saved data per recording: segments, regions, settings, per-frame numbers and 16×12 greyscale thumbnails, kept in this browser's IndexedDB until deleted.
- MediaPipe Tasks sends usage metrics (not images) to `odml.pa.googleapis.com` by default. The page's Content-Security-Policy blocks all network connections except the app's own origin and Google's model host, so those metrics are not sent. The model host is only contacted if the bundled model is missing.
- No login, analytics or telemetry.

## Code

| Path | Contents |
|---|---|
| `src/tracking/` | Copied from UC_TFR. `MediaPipeFaceTracker.ts` accepts decoded frames as well as video elements; the others are unchanged. |
| `src/video/` | WebM index and WebCodecs analysis of a time stretch |
| `src/capture/` | Screen/window capture, time estimation and alignment |
| `src/analysis/` | Interval sets, per-frame measurement, gaze model, live projection, regions and glances |
| `src/timeline/` | Event timeline format checks, clock arithmetic, and reading Moodle review pages |
| `src/store/` | Data types, IndexedDB storage, export and import |
| `src/ui/` | App, gaze plane, timelines, event timeline panel, synchronised video window |
| `tests/` | Unit tests (synthetic WebM, simulated gaze, capture alignment) |

Licence: MPL 2.0, as UC_TFR.
