# UP N AT EM

**An alarm you can't just swipe away. It only turns off once you've done your push-ups and/or sit-ups in front of your webcam.**

This is a browser proof-of-concept. You open it, build a workout (say "45 push-ups, then 30 sit-ups"), hit **Start**, and a looping alarm tone begins. The only honest way to make it stop is to actually complete the reps while your webcam watches you. No mute button, no snooze.

It's a working demonstration of the idea you described: set an alarm, go to turn it off, and instead the camera opens and makes you earn the silence.

---

## What's in the box (and what's not yet)

**What works today:**
- A live camera view. (The "skeleton" drawn over your body is currently turned off on purpose, because in this runtime it floated detached from you instead of lining up on your body; see the honest-scope section below for why, and how it could come back.)
- Real-time counting of push-ups and/or sit-ups.
- Settings to choose the exercise(s), how many reps, and a difficulty (easy / standard / hard).
- Chaining multiple workouts in order (e.g. push-ups *then* sit-ups).
- A looping alarm that will NOT stop until you finish the whole workout.
- An emergency "hold-to-cancel" escape, for safety (more on that below).

**What's parked for later** (see the "Parked / not yet built" section at the bottom):
- A real, native phone alarm that fires at 6:00 AM while your phone is locked.

---

## How to run it

You'll need [Node.js](https://nodejs.org/) installed (version 18 or newer is fine; this was built on Node 22). If you can run `node --version` in a terminal and see a number, you're good.

Open a terminal in this project folder and run:

```bash
npm install     # one-time: downloads the libraries this app needs
npm run dev     # starts a local dev server
```

Then open the URL it prints (usually **http://localhost:5173**) in your browser. Your browser will ask for permission to use the camera: say yes, otherwise the app has nothing to watch.

> **Camera framing:** the app asks the camera for a high resolution but does **not** force a particular shape (aspect ratio), so the camera returns its own full, un-cropped picture. This matters: a lot of plain webcams have a 4:3 sensor, and if you *demand* a 16:9 picture from a 4:3 sensor the camera obeys by cropping off the top and bottom — which makes the view look zoomed in, the opposite of what we want. By asking only for a resolution and letting the camera keep its natural shape, you get its true wide field of view. It asks politely (an "ideal" preference, not a hard demand), and if a particular camera doesn't like those settings it quietly falls back to a plain request so the app still works. The on-screen box is sized to match the camera's real frame shape, so nothing is cropped and there are no awkward black bars. A tiny readout in the corner of the video (for example `Camera: 640×480`) shows the real capture size the camera handed back, so "it looks zoomed" becomes a concrete number you can check. If the view still looks too zoomed in after this, the remaining cause is usually a *hardware/driver* zoom or field-of-view setting in your camera's own utility (on Windows, the Camera app's settings) — that lives outside the browser, so you'd adjust it there.

> **First run needs internet.** The pose-detection model (the thing that finds your body) downloads its "brain" from the web the first time the page loads, now the BlazePose model from tfhub.dev. After that it's cached. (This is a browser-runtime download only; it does not affect `npm run build`.)

Other commands you might use:

```bash
npm run build   # bundles a production-ready version into the dist/ folder
npm run preview # serves that production build locally so you can try it
npm test        # runs the automated tests on the core logic
```

> **Note on the camera:** the webcam, the skeleton overlay, and the alarm all need a real browser with a camera and a screen. They can't run on a server with no display, which is why the automated tests (`npm test`) only check the *math and logic*, not the camera. That's a good thing: the trickiest, most important part (counting reps correctly) is fully tested without needing a human to do push-ups.

---

## How the rep counting actually works

This is the interesting part, and it's simpler than it sounds. Here's the whole pipeline in plain terms:

**1. The camera gives us a picture, many times a second.**

**2. A pose-detection model finds your joints.** We use a model called **BlazePose**, run through TensorFlow.js (the `tfjs` runtime). For each video frame it returns the pixel positions of 33 body "keypoints": your shoulders, elbows, wrists, hips, knees, plus extras like eyes, ears and feet. Think of it as the model dropping a labeled dot on each joint. BlazePose does one more thing MoveNet could not: alongside the flat picture positions it also returns an **estimated 3D position** for each joint (an x, y and z in rough real-world meters), so for every joint we get not just "where on the screen" but "roughly how far toward or away from the camera". Those 3D positions are what the whole rebuild runs on: in this runtime the flat 2D pixels come back null (see the surprise notes below), while the 3D landmarks are fully populated, so measuring a **joint angle in 3D** lets us count a push-up from the side or an angle robustly, and gives front-facing its best realistic shot (best-effort — see the honest-scope section).

   A fair warning up front: that 3D is **estimated, not measured**. A single webcam has no true depth sensor, so BlazePose is *guessing* the z from one flat picture. It's good enough that a 3D elbow angle reads a bent elbow as bent from most viewpoints, which is a big step up from a flat 2D picture, but it's noisier than a clean side-profile angle read from a real image — which is exactly why pure front-facing stays best-effort. The same things that keep the signal trustworthy tame that noise: the **smoothing** (5c), the **two-threshold hysteresis** (step 4), and the **confidence gating** (5).

   > **Why BlazePose instead of MoveNet.** MoveNet was fast and gave clean 2D dots, but 2D-only made head-on and angled push-ups hard to read, and in this runtime its 2D pixels came back null anyway. BlazePose's estimated 3D world landmarks are what the 3D-angle method needs. The trade-off is that BlazePose is a heavier model, so it can take a touch longer to load and costs a little more work per frame; we default to its lightest variant (`lite`) to keep the per-frame cost down, with `full` (and `heavy`) available as higher-quality fallbacks if a machine can afford them. That choice lives in [`src/hooks/usePoseDetector.js`](src/hooks/usePoseDetector.js), and the thin "keep each joint by name and attach its depth z" adapter is the pure [`src/logic/keypointAdapter.js`](src/logic/keypointAdapter.js).

   > **One surprise we had to work around (why the adapter also rebuilds the screen position).** In this `tfjs` BlazePose runtime, the flat-picture (2D) pixel positions come back **empty** (`x` and `y` are `null`) for every joint, even though the 3D estimate is fully filled in. We proved this with a live console dump of a real frame. Because the whole app used to read those 2D pixels, that one quirk broke everything at once: no skeleton drew, the body-size "ruler" could not be measured, nothing counted, and the get-into-position countdown misbehaved (it was fed confidence from the broken 2D side). The fix leans on the data that *is* there: the adapter takes each joint's working 3D position and **projects it back onto the screen** to rebuild a usable pixel x/y (it places your body-center in the middle of the frame and scales meters to pixels). So the ruler and the sit-up angle all work off those rebuilt positions, while the push-up depth math keeps using the true meters. If a future model build ever returns real pixels, the adapter uses those instead automatically.

   > **Why this runtime quirk also explains the floating skeleton.** The reason those 2D pixels come back `null` is worth knowing: the detector builds real screen pixels by multiplying each joint's normalized position by the video's frame size, but it reads that size from the `<video>` element's `width`/`height` attributes, which this app never sets, so it reads 0×0 and hands back a zero (effectively empty) pixel for every joint. That is why the adapter has to rebuild pixels from the 3D position. Those rebuilt pixels carry your body *shape* but not your true *position in the picture* (they're centered in the frame by construction), so a skeleton drawn from them floats detached from where you actually are. That is exactly why the overlay is turned off for now; counting is unaffected because it uses the rebuilt pixels for size and the true meters for depth, neither of which needs the skeleton to be drawn. See the honest-scope section for how the overlay could return.

   > **A second surprise is why push-ups stopped using pixels entirely.** An earlier version tried to count push-ups from the upper body's *position* dip — a vertical pixel dip plus a depth dip — measured against a locked body-size "ruler". It flatlined live: the ruler locked, the detector was confident and armed, yet nothing counted, because the per-frame vertical read came back `null` (it leaned on the same rebuilt pixels) and the depth dip stayed frozen. Rather than keep patching a pixel/depth position signal, we switched push-ups to the **3D elbow joint angle** (the method this README now describes), which reads the shoulder/elbow/wrist straight from the 3D world landmarks and never touches a pixel or needs a ruler. The old position helpers still live in [`src/logic/upperBodySignal.js`](src/logic/upperBodySignal.js) and [`src/logic/verticalRepCounter.js`](src/logic/verticalRepCounter.js) for reference and their tests, but the live push-up path no longer uses them.

**3. We turn those joints into one simple number to watch.** You don't need all 33 joints to count a rep, just enough to see the movement. Both exercises are now counted the same way — a **joint angle** that opens and closes — because that is how essentially every working rep counter does it, and because an angle sidesteps the one quirk that broke everything else (see the surprise notes above): it never reads the null 2D pixels at all.
   - **Push-ups:** we watch the **elbow joint angle** (shoulder → elbow → wrist). Arms extended at the top of a push-up is a wide angle (~150–160°); elbows bent at the bottom is a small angle (~90–110°). A little up/down state machine (step 4) turns "bend then straighten" into one rep. This is the standard way side-view push-up counters work, and the reason it holds up here is that we measure the angle in BlazePose's **3D world landmarks (meters)**, not pixels — a 3D angle is scale-invariant (it doesn't matter how big you look in frame) and far less viewpoint-dependent (a bent elbow reads as bent whether you're side-on, angled, or roughly facing the camera).
   - **Sit-ups:** we measure the **hip / torso angle** (shoulder → hip → knee). Lying flat ≈ wide open, sitting up ≈ folded shut. Sit-ups now read that angle in the **same 3D world-landmark space (meters)** push-ups use, via `angleBetween3D`, for exactly the same reason: in this runtime the flat 2D pixels come back null and are only *rebuilt* from the 3D, so measuring the torso angle on those rebuilt, frame-centered pixels was unreliable. A real joint angle in degrees is the same quantity whether you compute it from meters or pixels, so the sit-up thresholds did not have to change — only the coordinate space the angle is read from did.

   > **Why an angle and not a pixel "ruler" anymore.** An earlier version watched the upper body's *position* dip (down the screen plus toward the lens) measured as a fraction of a pixel/meters "body-size ruler". That approach leaned on the flat 2D pixel positions, and in this runtime those come back null and are only rebuilt from the 3D (see the surprise notes above), so the ruler and the dip went unreliable and real users counted zero. A joint angle computed straight from the 3D landmarks never touches a pixel and needs no ruler to lock — an angle is already scale- and viewpoint-invariant — so the whole class of "the ruler was moving while we measured against it" problems simply goes away. The angle math for both exercises lives in `angleBetween3D` in [`src/logic/angles.js`](src/logic/angles.js), with the geometry explained in plain comments.

   The camera only ever sees one side of you clearly, so each frame we check **both your left and right side** and use whichever one the camera can see best. For push-ups that means picking whichever arm's shoulder/elbow/wrist the camera sees most confidently; for sit-ups, whichever shoulder/hip/knee. So it doesn't matter which way you face: if your left side is hidden behind your body, the app automatically tracks your right side instead. The "pick the more visible side" logic lives in [`src/logic/exercises.js`](src/logic/exercises.js) (`pickBetterSide`).

**4. We count a rep on a full down-then-up movement.** A little state machine watches the angle:
   - It starts in the **up** position (push-up: arms extended / sit-up: lying flat — a wide-open angle).
   - When the angle closes *past* a "down" threshold (push-up: elbows bent far enough / sit-up: torso folded far enough), it switches to the **down** state.
   - When the angle opens back *past* an "up" threshold (push-up: arms straighten back out / sit-up: you lie back flat), that's **one rep**, and it flips back to **up**.

   There are two different thresholds on purpose (a technique called *hysteresis*). If we used a single line, tiny wobbles while you hold a position would rack up dozens of fake reps. The gap between the two thresholds means you have to make a real, full movement for a rep to count. **Both** exercises now use the same angle-based state machine in [`src/logic/repCounter.js`](src/logic/repCounter.js), fed the down/up angle thresholds for the current exercise and difficulty.

   > **The honest trade-off.** The elbow angle is read from *estimated* 3D landmarks (a single webcam has no true depth sensor, so BlazePose guesses the z from one flat picture), so it carries a little more noise than a clean side-profile angle measured off a real image would. We accept that on purpose: the 3D angle is what lets the same signal work side-on, angled, and (best-effort) head-on without depending on the null 2D pixels. Four things keep it trustworthy anyway: the **smoothing** (5c), the **two-threshold hysteresis** (above), the **confidence gating** (5), and the **5-second get-into-position countdown** (5d), which together reject jitter and casual bobbing while still counting genuine reps.

**5. Anti-cheat, part 1: no valid pose, no counting.** Every keypoint comes with a confidence score (how sure the model is it really sees that joint). If the joints we need for the current exercise aren't clearly visible (you're off-screen, the lighting is bad, you're trying to fake it with your hand), the counter simply *ignores* those frames and won't advance. You can't earn reps the camera can't actually verify.

**5b. Anti-cheat, part 2: you can't fake it by bobbing.** Counting a down-then-up movement on its own isn't quite enough. The worry is that you just *stand there and bob up and down* a little to fake push-ups.

   For **sit-ups**, we add a light **horizontal** sanity check: we look at the tilt of the line from your shoulder to your hip (lying flat is near 0°, standing is near 90°) and rule out an obviously fully-standing body. The threshold is forgiving on purpose — your torso tilts up a lot at the top of a sit-up — so it only rejects someone who is clearly standing. This lives in `isBodyHorizontal` / `evaluateOrientation` in [`src/logic/angles.js`](src/logic/angles.js) and [`src/logic/exercises.js`](src/logic/exercises.js).

   For **push-ups** we use a coarse **3D posture gate** instead. The idea is the same (reject an obviously standing body) but it is judged from the real-world 3D landmarks rather than the null 2D pixels. During a real push-up or plank your whole torso is stretched out roughly **level with the floor**, so the line from your shoulders to your hips is nearly **horizontal** in the real world; when you stand up, that same line is nearly **vertical**. The gate builds a torso line from the 3D shoulder-center to the 3D hip-center and measures how far it tilts away from flat (0° = lying level, 90° = standing upright). If the tilt is within `postureMaxTiltDegrees` (starting value **50°**, tunable live) it calls it a push-up posture.

   The honest trade-offs: this is a **coarse gate, not a precise plank detector** — its one job is to separate "standing tall" from "down on the floor". It **fails open** (lets the frame through) only when it genuinely cannot tell, i.e. the 3D shoulder/hip landmarks it needs are missing, so a dropped keypoint never silently blocks a real rep (the confidence gate handles "we can't see you"). And front-facing stays best-effort: the elbow angle is the real backbone of counting, and this gate just keeps a standing body from arming the countdown or counting a bob. The gate is the pure `isPushupPosture3D` in [`src/logic/exercises.js`](src/logic/exercises.js), reached through `evaluateOrientation` (the push-up descriptor's `orientation: 'pushup3d'`). Because the same in-position boolean also drives the 5-second countdown, a standing body can neither arm the countdown nor count a rep.

**5c. Smoothing: steadier, less jumpy counting.** The detector runs fresh every frame, so the keypoint positions (and therefore the number we watch — the elbow angle for push-ups, the hip/torso angle for sit-ups) wobble a little frame to frame. Before that number reaches the rep state machine we run it through a small **moving average** of the last few readings. That calms the jitter and keeps a single bad frame from spiking across a threshold, so counting stays smooth even during fast reps. The same averaging helper smooths a position just as well as an angle. It's layered *on top of* the hysteresis band and the anti-cheat gate, not instead of them. See `createAngleSmoother` in [`src/logic/angles.js`](src/logic/angles.js).

**5d. Get into position first (the 5-second pause/resume countdown).** Counting doesn't start the instant the screen appears. Each step begins *disarmed*: the HUD shows **"Get into push-up position…"** (it swaps in the right exercise name) and no reps are counted yet. The moment the camera sees you in the correct position, a big **5-second countdown** starts ticking down: **5 → 4 → 3 → 2 → 1**. When it reaches **0** the prompt flips to **"✓ Ready — GO!"** and rep counting begins.

Here's the friendly part: the countdown only runs *while you are in position*. If you drop out of position partway through, the countdown **pauses** — it freezes exactly where it was (and the HUD shows a "Paused — get back into position…" hint) instead of snapping back to 5. When you get back into position it **resumes from where it left off**. So two seconds of holding plus a wobble plus three more seconds of holding still adds up to the full five. That rewards actually holding the position without punishing a brief wobble, and a quick flicker *through* the position barely moves the clock at all. Each exercise re-arms from scratch when it starts (the start position for push-ups and sit-ups is different), but once a step is armed it stays armed for the rest of that set — the per-rep position check (5b) already throws out any sloppy reps. The alarm keeps blaring through all of this; getting into position does **not** give you any relief. The pure, unit-tested timing logic lives in [`src/logic/positionGate.js`](src/logic/positionGate.js).

**6. Difficulty changes the thresholds.** "Hard" demands a deeper range of motion (for a push-up, a *deeper* elbow bend plus a *straighter* lockout; for a sit-up, a tighter fold) and sets a higher default rep count, 45 push-ups for example. "Easy" is more forgiving. Both exercises are now tuned **in degrees** in [`src/logic/exercises.js`](src/logic/exercises.js). The push-up elbow-angle presets (bend past `downAngle` to go down, straighten past `upAngle` to finish a rep) are starting values meant to be felt out live via the debug readout:

   | difficulty | downAngle (bend past) | upAngle (straighten past) | default reps |
   |------------|-----------------------|---------------------------|--------------|
   | easy       | 110°                  | 150°                      | 10           |
   | standard   | 100°                  | 155°                      | 20           |
   | hard       | 90°                   | 160°                      | 45           |

   Harder = a **smaller** `downAngle` (a deeper bend) + a **bigger** `upAngle` (a straighter lockout) + more reps.

**7. Multiple workouts chain in order.** If you set "45 push-ups then 30 sit-ups", the alarm only stops once *both* steps hit their targets, in order. That progression is tracked in [`src/logic/workoutQueue.js`](src/logic/workoutQueue.js).

---

## The live debug readout and the diagnostics report

Tuning a camera detector by guessing at numbers is painful, because you can't *see* what the camera is actually producing. So for push-ups there are two tools that show you the real numbers the detector used, the same data-driven approach that turned "it looks zoomed in" into the concrete `Camera: 640×480` readout in the corner of the video.

**The live debug readout** is a small, always-on panel that shows the exact numbers the push-up detector used *this frame* (it shows nothing on a sit-up step). The values are *throttled* so the panel can't flicker or re-render at full frame rate, but they're the real ones the detector decided on, not a recomputed guess. Each line means:

- **elbow angle (smoothed)** — the 3D elbow angle in degrees the counter actually saw this frame (after smoothing). This is the number everything hinges on: for a rep it has to bend *down* past the down threshold, then open back *up* past the up threshold.
- **raw elbow angle** — the same elbow angle *before* smoothing, so you can compare how much the moving average calmed it down.
- **down ≤ … · up ≥ …** — the two angle thresholds shown side by side: bend the elbow to at or below `downAngle` to go "down", straighten it to at or above `upAngle` to complete the rep. Seeing the live angle next to both makes it obvious whether a real push-up is moving it far enough in each direction.
- **confident** — whether the joints we need (shoulder, elbow, wrist) were clearly visible this frame (anti-cheat part 1).
- **armed** — whether the 5-second get-into-position countdown has finished and counting is live.
- **phase** — the state machine's current phase, `up` or `down`.
- **posture** — what the 3D posture gate decided: `ok` (torso roughly level — looks like a push-up) or `standing` (rejected).
- **reps** — the running count.

**The diagnostics report** is your "way to watch the video" without a webcam in front of us. The moment a push-up set *arms* (the "GO!" moment), a recorder starts capturing those same per-frame numbers side by side with the thresholds they're aiming for. When the set finishes (or you emergency-exit), the report is available two ways: an **expandable block on screen** (click "Show report" to reveal the full JSON in a text box you can copy) and the same JSON **logged to the browser console**. It carries every (capped) sample plus a short summary. Each sample records the **smoothed and raw elbow angle, the down/up thresholds, phase, posture, confident, armed and reps**, so a copied report shows exactly how the angle moved through the set. The summary includes `summary.downAngleReached` (whether the smoothed angle ever bent past the "down" threshold during the set), the `minAngle` (deepest bend) and `maxAngle` (straightest) reached, and `repsCounted`. The recorder is the pure `createPushupDiagnostics` in [`src/logic/pushupDiagnostics.js`](src/logic/pushupDiagnostics.js); the on-screen panel is [`src/components/DebugReadout.jsx`](src/components/DebugReadout.jsx).

**How you actually use these to tune.** You read the numbers back to us and we set the thresholds from real data instead of guessing. The concrete levers:

- If a real rep's **elbow angle never bends down to `downAngle`** (the `minAngle` in a copied report stays well above it), that difficulty's `downAngle` is set too deep (too small) for how your camera reads the bend: raise it. The push-up starting values are `easy` 110°, `standard` 100°, `hard` 90°, with matching `upAngle` 150° / 155° / 160°, in [`src/logic/exercises.js`](src/logic/exercises.js).
- If the angle **never opens back up to `upAngle`** at the top (the `maxAngle` stays below it), your lockout isn't registering: lower `upAngle`.
- If **posture shows "standing" during a real push-up**, the 3D posture gate is too strict: raise `postureMaxTiltDegrees` (starting value 50°) so a more-tilted torso still counts as a push-up.
- If **`summary.downAngleReached` is `false` after a real set**, that's the clearest single signal that `downAngle` is set too deep for how your body looks to this camera.

---

## Honest scope: what works now, and the trade-offs behind it

**Push-ups are counted from the 3D elbow joint angle.** That is the headline of this pass and it is how essentially every working push-up counter does it: watch the shoulder → elbow → wrist angle bend and straighten through an up/down state machine. The key choice is that the angle is measured in BlazePose's **3D world-landmark space (meters)**, not the 2D pixels — which in this runtime come back null and are only rebuilt from the 3D anyway. A 3D angle is scale-invariant and far less viewpoint-dependent, so the same signal works whether the camera is to your side or at an angle.

**Honest reliability: side and angled views should be reliable; pure front-facing is best-effort only.** Measuring a bent elbow from the side or a three-quarter angle is exactly what this method is good at. Pure head-on, a single webcam has no true depth and BlazePose is *guessing* the toward/away part of each joint, so a straight-on push-up is the hardest case and may miscount or under-count. We do not claim front-facing is solved — it is the honest limit of one camera with no depth sensor. If front-facing matters, film from the side or slightly angled.

**What works now:**
1. **Side-on and angled push-ups** counted from the 3D elbow angle + up/down state machine, independent of the null 2D pixels.
2. **Front-facing push-ups, best-effort.** The 3D angle gives front-facing its best realistic shot, but see the reliability note above — treat it as best-effort, not guaranteed.
3. **Standing still / bobbing doesn't count.** The 3D posture gate requires your torso to be roughly level with the floor (plank-like), so a standing body can neither arm the countdown nor count a rep.
4. **Sit-ups** moved to the 3D hip/torso angle for the same reason push-ups did — so neither exercise depends on the unreliable rebuilt 2D pixels.
5. **The debug readout and diagnostics report** show the real elbow angle and thresholds live and per-set, so the numbers get tuned from real data.

**The skeleton overlay is hidden for now, on purpose.** In this runtime the detector returns your joints only as hip-centered 3D *world* landmarks, which carry your body shape but no true position in the picture (see the two surprise notes above). The adapter rebuilds screen pixels from them by centering your body in the frame, which is perfect for measuring the *angles* counting needs, but it means a skeleton drawn from those pixels floats detached from where you actually are on screen. A wrong floating skeleton is worse than none, so the overlay is turned off behind a single clearly-named switch (`SHOW_SKELETON_OVERLAY`, which stays `false`, in [`src/components/CameraView.jsx`](src/components/CameraView.jsx)). Counting is completely unaffected: it reads the true 3D landmarks, not the drawn skeleton, so we deliberately did **not** chase the optional source-level 2D-pixel fix in this pass — counting correctness is the priority and the overlay adds no counting value. The overlay could come back once we have a real image-space position for each joint, in one of two ways: give the detector the video's real frame size (set the `<video>` element's `width`/`height` to its actual `videoWidth`/`videoHeight`) so it returns true on-screen pixels, or read the normalized 0-to-1 landmarks directly and scale them to the canvas. Flip the switch back to `true` once either is wired in.

**The honest trade-offs we accepted to get here:**
- **Estimated, not measured, depth.** A single webcam has no depth sensor, so the z BlazePose attaches to each joint is a best guess from one flat picture. The 3D elbow angle leans on all three axes, so it is noisier than a clean side-profile angle read from a real image would be — which is why front-facing stays best-effort and the smoothing, hysteresis and confidence gating all matter.
- **BlazePose is heavier than MoveNet.** The model is bigger, so first-load can take a little longer and each frame costs a little more work. We default to the lightest `lite` variant to protect the frame rate; if the angle looks too noisy on a capable machine, `full` is the quality lever. Keep an eye on load time and per-frame smoothness when tuning.

**Still parked, as the explicitly-sequenced next phase: the native phone alarm.** Wrapping this in a native layer (Capacitor) so a real alarm fires at 6:00 AM on a locked phone remains the planned follow-up, and it stays parked on purpose until detection is solid. See the "Parked / not yet built" section below.

---

## Quick vocabulary note: it's "pose detection", not "AR"

You mentioned phones having "AR cameras", and you're really close, it's just a different term. Here's the distinction:

- **AR (Augmented Reality)** means *drawing virtual stuff on top of the real world*, like a game character standing on your coffee table, or a furniture app showing a sofa in your living room. AR is about *adding* things to the picture.

- **Pose detection** (also called **pose estimation**) means *figuring out where a person's body is* in an image, finding the joints. That's what UP N AT EM does: it detects your body and measures your movement to count reps.

So the correct term for "the camera watches my body and counts my push-ups" is **pose detection**, not AR. Many phones *can* do both, and they sometimes share hardware, which is why the idea feels similar. But for this project, pose detection is the thing you want.

---

## The emergency escape (hold-to-cancel)

Locking an alarm behind exercise has an obvious safety problem: what if someone physically *can't* finish the reps? A sprained wrist, a bad morning, an actual emergency. An alarm that can never be turned off would be dangerous and dishonest.

So there's a deliberate, clearly labeled escape hatch: a **press-and-hold** button (hold it for about 3 seconds) that stops the alarm and ends the session *without* completing the reps. It's intentionally a hold, not a tap, so you can't silence the alarm by accident or on reflex while half asleep, but it's always there if you genuinely need it.

This is the honest version of the feature: the alarm is *hard* to dismiss without doing the work, not *impossible* to dismiss in an emergency.

---

## Parked / not yet built: the native "real 6 AM alarm"

The original dream is a **real alarm that fires at a scheduled time while your phone is locked and in your pocket**, exactly like your phone's built-in clock app, except turning it off opens the camera workout.

**That part is not built yet, and it's a deliberate decision.** A web page in a browser cannot schedule itself to wake up a locked phone and make noise at 6:00 AM, browsers don't allow that, for good reasons. Doing it properly requires wrapping this app in a **native layer** (using a tool like [Capacitor](https://capacitorjs.com/), which lets a web app run as a real installed phone app with access to native alarm/notification scheduling).

That's a planned follow-up. **For now, UP N AT EM is a browser proof-of-concept that you start manually**, it proves the camera-workout-to-dismiss-the-alarm loop works, which is the hard and novel part. Bolting on native scheduling later is a well-understood engineering task.

---

## Why this tech stack?

This is built with **Vite + React** (in plain JavaScript, no TypeScript, to keep it approachable). That was a deliberate choice: it's the same kind of stack that can later **fold into the "Juggernaut Fitness" app** rather than being a throwaway experiment. The core rep-counting logic is kept in plain, framework-free modules under `src/logic/`, so it can be lifted straight into another project later without dragging the UI along with it.

---

## Project layout

```
up-n-at-em/
├── index.html              # the page the app loads into
├── vite.config.js          # build config (see note on the mediapipe alias below)
├── src/
│   ├── main.jsx            # app entry point
│   ├── App.jsx             # top-level screens: settings → workout → success
│   ├── logic/              # pure, framework-free, fully unit-tested logic
│   │   ├── angles.js            #   joint-angle math: 2D + 3D (angleBetween3D) for BOTH exercises
│   │   ├── keypointAdapter.js   #   keeps joints by name + attaches 3D world landmarks (x3d/y3d/z3d)
│   │   ├── repCounter.js        #   the angle-based down-then-up state machine (push-ups + sit-ups)
│   │   ├── exercises.js         #   exercise + difficulty definitions + the 3D push-up posture gate
│   │   ├── workoutQueue.js      #   chaining multiple workouts in order
│   │   ├── pushupDiagnostics.js #   per-set recorder for the diagnostics report (elbow angle)
│   │   ├── upperBodySignal.js   #   LEGACY pixel/depth helpers from the old push-up method (kept for reference/tests)
│   │   ├── verticalRepCounter.js #  LEGACY position state machine from the old push-up method (kept for reference/tests)
│   │   └── __tests__/           #   Vitest tests for all of the above
│   ├── hooks/
│   │   ├── usePoseDetector.js  # loads BlazePose (tfjs, 3D), runs the detection loop
│   │   └── useAlarm.js         # the looping Web Audio alarm tone
│   └── components/
│       ├── CameraView.jsx      # webcam + skeleton overlay
│       ├── SettingsPanel.jsx   # build your workout
│       ├── ProgressHud.jsx     # live rep count + progress
│       ├── EmergencyExit.jsx   # the hold-to-cancel escape
│       ├── DebugReadout.jsx    # the live push-up debug panel + diagnostics report
│       └── WorkoutSession.jsx  # wires the camera to the rep-counting logic
└── src/stubs/mediapipe-pose.js # small build shim (see below)
```

> **One build note for the curious:** `vite.config.js` contains a small alias that points `@mediapipe/pose` at a tiny stub file. The pose-detection library references that package, but we run BlazePose through its **`tfjs` runtime**, which is self-contained and does *not* import `@mediapipe/pose` (that package belongs to the separate `mediapipe` runtime we don't use), and the real package doesn't bundle cleanly. The stub keeps the build clean and is still intentional, please don't remove it.

---

## The alarm sound

There's no audio file in this repo. The alarm tone is **generated in code** using the browser's Web Audio API (a pulsing square-wave beep). That keeps the project small (nothing big to download) and avoids any audio licensing questions. See [`src/hooks/useAlarm.js`](src/hooks/useAlarm.js).
