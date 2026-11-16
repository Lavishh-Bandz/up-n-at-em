# UP N AT EM

**An alarm you can't just swipe away. It only turns off once you've done your push-ups and/or sit-ups in front of your webcam.**

This is a browser proof-of-concept. You open it, build a workout (say "45 push-ups, then 30 sit-ups"), hit **Start**, and a looping alarm tone begins. The only honest way to make it stop is to actually complete the reps while your webcam watches you. No mute button, no snooze.

It's a working demonstration of the idea you described: set an alarm, go to turn it off, and instead the camera opens and makes you earn the silence.

---

## What's in the box (and what's not yet)

**What works today:**
- A live camera view with a "skeleton" drawn over your body.
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

**2. A pose-detection model finds your joints.** We use a model called **BlazePose**, run through TensorFlow.js (the `tfjs` runtime). For each video frame it returns the pixel positions of 33 body "keypoints": your shoulders, elbows, wrists, hips, knees, plus extras like eyes, ears and feet. Think of it as the model dropping a labeled dot on each joint. BlazePose does one more thing MoveNet could not: alongside the flat picture positions it also returns an **estimated 3D position** for each joint (an x, y and z in rough real-world meters), so for every joint we get not just "where on the screen" but "roughly how far toward or away from the camera". That extra depth number is what lets us count a push-up no matter which way you face the camera.

   A fair warning up front: that depth is **estimated, not measured**. A single webcam has no true depth sensor, so BlazePose is *guessing* the z from one flat picture. It's good enough to tell "moving toward the lens" from "moving away", which is a big step up from a flat 2D picture that can't see depth at all, but it's noisier than the on-screen x/y. The same things that already keep the 2D signal trustworthy also tame the depth: the **smoothing** (5c), the **two-threshold hysteresis** (step 4), the **confidence gating** (5), and the **stable locked ruler** (below) all apply to the depth signal too.

   > **Why BlazePose instead of MoveNet.** MoveNet was fast and gave clean 2D dots, but 2D-only is exactly what made head-on push-ups impossible to count (a push-up facing the camera is mostly movement toward and away from the lens, which barely changes the flat picture). BlazePose's estimated depth is the piece that was missing. The trade-off is that BlazePose is a heavier model, so it can take a touch longer to load and costs a little more work per frame; we default to its lightest variant (`lite`) to keep the per-frame cost down, with `full` (and `heavy`) available as higher-quality fallbacks if a machine can afford them. That choice lives in [`src/hooks/usePoseDetector.js`](src/hooks/usePoseDetector.js), and the thin "keep each joint by name and attach its depth z" adapter is the pure [`src/logic/keypointAdapter.js`](src/logic/keypointAdapter.js).

   > **One surprise we had to work around (why the adapter also rebuilds the screen position).** In this `tfjs` BlazePose runtime, the flat-picture (2D) pixel positions come back **empty** (`x` and `y` are `null`) for every joint, even though the 3D estimate is fully filled in. We proved this with a live console dump of a real frame. Because the whole app used to read those 2D pixels, that one quirk broke everything at once: no skeleton drew, the body-size "ruler" could not be measured, nothing counted, and the get-into-position countdown misbehaved (it was fed confidence from the broken 2D side). The fix leans on the data that *is* there: the adapter takes each joint's working 3D position and **projects it back onto the screen** to rebuild a usable pixel x/y (it places your body-center in the middle of the frame and scales meters to pixels). So the skeleton, the ruler and the sit-up angle all work off those rebuilt positions, while the push-up depth math keeps using the true meters. If a future model build ever returns real pixels, the adapter uses those instead automatically.

**3. We turn those joints into one simple number to watch.** You don't need all 33 joints to count a rep, just enough to see the movement. The two exercises watch different things, because they move in different ways:
   - **Push-ups:** we watch your **visible upper body move down-and-away and back up**, and we measure that movement in two directions at once: how far it dips *down the screen* (the 2D vertical position of your shoulder, averaged with your nose when the camera can see it) **and** how far it moves *toward the camera in depth* (the same joints' estimated z). We combine those into a single "how far down-and-away did the upper body move from its resting top position" number. The point of combining both is that it works from any viewpoint: filmed from the **side** a push-up is mostly a dip *down the screen* (the vertical part carries it), while filmed **head-on** a push-up is mostly a move *toward the lens* (the depth part carries it). Taking whichever of the two is larger means a side-on rep and a front-on rep each reach the threshold on their own. **We do *not* use your elbows, wrists, hips or legs** for the signal: a normal webcam physically *cannot fit your whole body* when you're down on the floor, so leaning on the upper body keeps it counting even when your legs and hips are out of frame.
   - **Sit-ups:** we measure the **hip / torso angle** (shoulder → hip → knee). Lying flat ≈ wide open, sitting up ≈ folded shut. **Nothing about sit-ups changed** with the new engine: they still run entirely off the 2D joint angle, because when you're sitting up your whole body fits in frame fine and the angle is already a clean, reliable signal.

   For push-ups, "how far did you move?" can't be counted in raw pixels or raw meters, because someone close to the camera looks huge and moves hundreds of pixels while someone far away looks tiny and moves only a few. So we measure each part of the dip as a **fraction of your own body size**, and we have to do that **on both directions**:
   - The **vertical** part is divided by your shoulder width **in pixels** (with a nose-to-shoulder fallback if only one shoulder shows), exactly as before.
   - The **depth** part is divided by your shoulder width **in meters** (from the same estimated 3D joints), its own separate ruler for the depth axis. The depth part also gets its sign flipped, because BlazePose reports z as *getting smaller* as a joint moves closer to the lens, so a front-facing dip *toward* the camera has to be turned into a positive "down-and-away" number to line up with the vertical dip.

   Expressing both as a fraction of your own body means a real push-up looks the same whether you're near or far, and the two fractions are now in the same units so it's fair to compare and combine them. That combined-signal math lives in [`src/logic/upperBodySignal.js`](src/logic/upperBodySignal.js). When no depth is available for a frame (for example a clean side-on view where 3D is shaky), the signal quietly falls back to the pure vertical dip, so the side path never got worse.

   > **The ruler is locked once, not measured every frame.** There's a subtle trap here that caused real push-ups to go uncounted. If we re-measured your body size *every single frame* and divided by it, the ruler itself would be moving while we tried to measure against it. Facing the camera this is really bad: as you go down into a push-up your shoulders rotate and tuck and your torso gets closer to the lens, so the apparent shoulder width *swings* through the rep. Dividing a real dip by a shrinking and growing ruler means a genuine rep can fail to cross the threshold cleanly while random noise sometimes does. The fix is to measure the ruler **once** and then leave it alone: during the 5-second get-into-position countdown (5d), while you're holding still at the top, we take a smoothed average of your body size and **lock** it as the ruler for the whole set. With the new engine we lock **two** rulers this way (the pixel one for the vertical part and the meters one for the depth part) plus the **resting top position** on each axis, so the dip is always measured from where you started. After that the only thing changing frame to frame is your actual movement, which is exactly what we want to measure. This stable-ruler logic is the pure `createBodyScaleTracker` and `createSignalReferenceTracker` in [`src/logic/upperBodySignal.js`](src/logic/upperBodySignal.js); if a lock somehow never captured a usable value it quietly falls back to the live per-frame measurement for that frame.

   The camera only ever sees one side of you clearly, so each frame we check **both your left and right side** and use whichever one the camera can see best. That means it doesn't matter which way you face: if your left shoulder is hidden behind your body, the app automatically tracks your right shoulder instead. The "pick the more visible side" logic lives in [`src/logic/exercises.js`](src/logic/exercises.js) (`pickBetterSide`), and the math for "the angle at a corner given three points" (used by sit-ups) lives in [`src/logic/angles.js`](src/logic/angles.js), with the geometry explained in plain comments.

**4. We count a rep on a full down-then-up movement.** A little state machine watches the number:
   - It starts in the **up** position (push-up: upper body high / sit-up: lying flat).
   - When you move *past* a "down" threshold (push-up: your upper body dips far enough toward the floor / sit-up: your torso folds shut enough), it switches to the **down** state.
   - When you come back *past* an "up" threshold (push-up: your upper body rises back up / sit-up: you lie back flat), that's **one rep**, and it flips back to **up**.

   There are two different thresholds on purpose (a technique called *hysteresis*). If we used a single line, tiny wobbles while you hold a position would rack up dozens of fake reps. The gap between the two thresholds means you have to make a real, full movement for a rep to count. Sit-ups use the angle-based state machine in [`src/logic/repCounter.js`](src/logic/repCounter.js); push-ups use the position-based one in [`src/logic/verticalRepCounter.js`](src/logic/verticalRepCounter.js), which measures the down-then-up dip against an adaptive "resting" baseline so it keeps up as you shift around.

   > **The honest trade-off.** Watching the upper body's *position* (now in both screen and depth) is a little less precise than reading a clean side-profile *elbow angle*, and the depth half of that signal is *estimated* from a single camera rather than truly measured, so it carries some extra noise. We accept both on purpose, because this is the only approach that fits inside a real webcam's field of view *and* counts a head-on push-up at all. Four things keep it trustworthy anyway: the **smoothing** (5c), the **two-threshold hysteresis** (above), the **confidence gating** (5), and the **5-second get-into-position countdown** (5d), which together reject jitter and casual bobbing while still counting genuine reps.

**5. Anti-cheat, part 1: no valid pose, no counting.** Every keypoint comes with a confidence score (how sure the model is it really sees that joint). If the joints we need for the current exercise aren't clearly visible (you're off-screen, the lighting is bad, you're trying to fake it with your hand), the counter simply *ignores* those frames and won't advance. You can't earn reps the camera can't actually verify.

**5b. Anti-cheat, part 2: you can't fake it by bobbing.** Counting a down-then-up movement on its own isn't quite enough. The worry is that you just *stand there and bob up and down* a little to fake push-ups.

   For **sit-ups**, we add a light **horizontal** sanity check: we look at the tilt of the line from your shoulder to your hip (lying flat is near 0°, standing is near 90°) and rule out an obviously fully-standing body. The threshold is forgiving on purpose — your torso tilts up a lot at the top of a sit-up — so it only rejects someone who is clearly standing. This lives in `isBodyHorizontal` / `evaluateOrientation` in [`src/logic/angles.js`](src/logic/angles.js) and [`src/logic/exercises.js`](src/logic/exercises.js).

   For **push-ups** we deliberately do *not* use that shoulder-to-hip check anymore. The hip is exactly the keypoint a webcam can't fit during a floor push-up, so requiring it would re-break counting for the very users this redesign is meant to help. Instead there's a dedicated **upper-body-only anti-standing guard** that looks at the shoulders, nose and wrists, and never asks to see your hip or legs. It uses two cues:

   - **Your head isn't stacked high above your shoulders.** When you stand tall, your nose sits *far* above your shoulder line; when you're down in a push-up or plank, your head drops forward and your head and shoulders are much closer to level. So if the nose is more than a set fraction of a body-size *above* the shoulder, the guard calls it "standing" and rejects the frame. With the old 2D-only engine this cue had a weakness head-on: facing the camera you can hold a perfectly good head-up plank where your nose *looks* high up the flat picture even though in the real world it's barely above your shoulders, and the flat test would wrongly call that "standing". The new engine fixes this by measuring the head-above-shoulder gap along the **real-world vertical axis** (the estimated 3D y, in meters) as a fraction of your 3D shoulder width whenever depth is available, so a front-facing head-up plank is no longer falsely rejected while a genuinely standing or walking body (head a big real-world distance above the shoulders) still is. On a pure-2D frame with no depth it falls back to the old flat screen-y test. The 3D threshold is `uprightNose3DFraction` = 0.9 of a 3D body-size, with the flat-picture fallback `uprightNoseFraction` = 0.6.
   - **Your wrists are planted and still, when the camera can clearly see them.** During a real floor push-up your hands are planted on the floor, so your wrists sit *below* your shoulders (a bigger y, since y grows downward) and barely move frame to frame. A standing or walking person's wrists hang around hip height and swing. *When both wrists are confidently visible*, the guard requires them to be planted (at least `wristPlantedMargin` = 0.15 of a body-size below the shoulders) and roughly stationary (moving less than `wristStationaryFraction` = 0.2 of a body-size between frames); clearly-visible dangling or swinging wrists veto the frame.

   The honest trade-offs: webcam wrists are often low-confidence or out of frame during a push-up, so the wrist cue is used as a *positive confirmation only when wrists are clearly visible*, never as a hard every-frame requirement (demanding it would re-break counting the same way the old hip requirement did). And the "head above shoulders" test is a coarse upright check, not a precise plank detector, tuned specifically to separate "standing tall" from "down on the floor". The guard also *fails open*: if it can't tell (no usable keypoints or no ruler), it lets the frame through rather than silently blocking a genuine rep. When the guard does say "standing", the rep counter refuses to let that dip *enter* the down phase, so a standing or walking bob can't start, let alone complete, a rep. This guard is the pure `isPushupPosture` / `createPostureGuard` in [`src/logic/upperBodySignal.js`](src/logic/upperBodySignal.js), with its starting numbers (`DEFAULT_POSTURE_CONFIG`) placed on the push-up descriptor in [`src/logic/exercises.js`](src/logic/exercises.js) so they're easy to find and tune. Layered on top, the dip is still measured as a **fraction of your own body size**, so a small standing nod stays a tiny fraction while a real floor push-up is a big one, and the two-threshold hysteresis and 5-second countdown remain in place too.

**5c. Smoothing: steadier, less jumpy counting.** The detector runs fresh every frame, so the keypoint positions (and therefore the number we watch — the elbow-era angle for sit-ups, the upper-body y for push-ups) wobble a little frame to frame. Before that number reaches the rep state machine we run it through a small **moving average** of the last few readings. That calms the jitter and keeps a single bad frame from spiking across a threshold, so counting stays smooth even during fast reps. The same averaging helper smooths a position just as well as an angle. It's layered *on top of* the hysteresis band and the anti-cheat gate, not instead of them. See `createAngleSmoother` in [`src/logic/angles.js`](src/logic/angles.js).

**5d. Get into position first (the 5-second pause/resume countdown).** Counting doesn't start the instant the screen appears. Each step begins *disarmed*: the HUD shows **"Get into push-up position…"** (it swaps in the right exercise name) and no reps are counted yet. The moment the camera sees you in the correct position, a big **5-second countdown** starts ticking down: **5 → 4 → 3 → 2 → 1**. When it reaches **0** the prompt flips to **"✓ Ready — GO!"** and rep counting begins.

Here's the friendly part: the countdown only runs *while you are in position*. If you drop out of position partway through, the countdown **pauses** — it freezes exactly where it was (and the HUD shows a "Paused — get back into position…" hint) instead of snapping back to 5. When you get back into position it **resumes from where it left off**. So two seconds of holding plus a wobble plus three more seconds of holding still adds up to the full five. That rewards actually holding the position without punishing a brief wobble, and a quick flicker *through* the position barely moves the clock at all. Each exercise re-arms from scratch when it starts (the start position for push-ups and sit-ups is different), but once a step is armed it stays armed for the rest of that set — the per-rep position check (5b) already throws out any sloppy reps. The alarm keeps blaring through all of this; getting into position does **not** give you any relief. The pure, unit-tested timing logic lives in [`src/logic/positionGate.js`](src/logic/positionGate.js).

**6. Difficulty changes the thresholds.** "Hard" demands a deeper range of motion (a bigger dip for a push-up, a tighter fold for a sit-up) and sets a higher default rep count, 45 push-ups for example. "Easy" is more forgiving. The presets live in [`src/logic/exercises.js`](src/logic/exercises.js) — sit-ups are tuned in degrees, push-ups in fractions of your body size.

**7. Multiple workouts chain in order.** If you set "45 push-ups then 30 sit-ups", the alarm only stops once *both* steps hit their targets, in order. That progression is tracked in [`src/logic/workoutQueue.js`](src/logic/workoutQueue.js).

---

## The live debug readout and the diagnostics report

Tuning a camera detector by guessing at numbers is painful, because you can't *see* what the camera is actually producing. So for push-ups there are two tools that show you the real numbers the detector used, the same data-driven approach that turned "it looks zoomed in" into the concrete `Camera: 640×480` readout in the corner of the video.

**The live debug readout** is a small, always-on panel that shows the exact numbers the push-up detector used *this frame* (it shows nothing on a sit-up step). The values are *throttled* so the panel can't flicker or re-render at full frame rate, but they're the real ones the detector decided on, not a recomputed guess. Each line means:

- **dip (smoothed) / need** — the normalized *combined* dip the counter actually saw this frame (after smoothing), next to the `downFraction` it has to reach to go "down". This is the single most important pair: for a rep to start, the left number has to climb past the right one. Because the combined dip is the larger of the vertical and depth parts, this is the one that drives the count whichever way you face.
- **raw dip** — the same combined dip *before* smoothing, so you can compare how much the moving average calmed it down.
- **vertical dip (y) / depth dip (z)** — the two parts that feed the combined number, shown separately so you can see *which direction* a rep is being counted in. Side-on, the vertical (y) part should be the bigger one; head-on, the depth (z) part should be. Both are already normalized into fractions of your body size, so they are directly comparable to each other and to the `need` threshold.
- **up threshold** — the smaller `upFraction` the dip has to shrink back past to complete the rep.
- **bodyScale** — the vertical ruler actually in use, in pixels, tagged `(locked)` once the 5-second countdown locked it or `(live)` before then.
- **depthScale** — the depth ruler (3D shoulder width, in meters), tagged `(locked)`/`(live)` the same way, plus a flag for whether depth is actually being used this frame or the signal fell back to pure vertical.
- **upperY** — the raw upper-body y (pixels) the vertical part is tracking.
- **confident** — whether the joints we need were clearly visible this frame (anti-cheat part 1).
- **armed** — whether the 5-second get-into-position countdown has finished and counting is live.
- **phase** — the state machine's current phase, `up` or `down`.
- **posture** — what the anti-standing guard decided: `ok` (looks like a push-up) or `standing` (rejected).
- **reps** — the running count.

**The diagnostics report** is your "way to watch the video" without a webcam in front of us. The moment a push-up set *arms* (the "GO!" moment), a recorder starts capturing those same per-frame numbers side by side with the thresholds they're aiming for. When the set finishes (or you emergency-exit), the report is available two ways: an **expandable block on screen** (click "Show report" to reveal the full JSON in a text box you can copy) and the same JSON **logged to the browser console**. It carries every (capped) sample plus a short summary. Each sample now records the **vertical (y) and depth (z) parts and whether depth was used**, not just the combined dip, so a copied report shows which viewpoint drove a set. The summary includes `summary.downFractionReached` (whether the smoothed dip ever reached the "down" threshold during the set), whether depth was ever seen, and the biggest vertical and biggest depth dips reached. The recorder is the pure `createPushupDiagnostics` in [`src/logic/pushupDiagnostics.js`](src/logic/pushupDiagnostics.js); the on-screen panel is [`src/components/DebugReadout.jsx`](src/components/DebugReadout.jsx).

**How you actually use these to tune.** You read the numbers back to us and we set the thresholds from real data instead of guessing. The concrete levers:

- If a real rep's **dip (smoothed) never reaches the "need" value**, that difficulty's `downFraction` is too deep: lower it. (The starting values are `easy` 0.12, `standard` 0.16, `hard` 0.22, with matching `upFraction` 0.05 / 0.06 / 0.08, in [`src/logic/exercises.js`](src/logic/exercises.js).)
- If you're **facing the camera and the depth dip (z) stays tiny** while a real push-up goes uncounted, the estimated depth isn't carrying the rep; check that `depthScale` locked and that depth is on, and read the depth dip back so we can tune from it. Side-on, expect the vertical dip (y) to be the bigger part instead, and that's fine.
- If **posture shows "standing" during a real push-up**, the upright test is too strict: raise `uprightNose3DFraction` (starting value 0.9) when depth is present, or the flat-picture fallback `uprightNoseFraction` (starting value 0.6) when it isn't.
- If **`summary.downFractionReached` is `false` after a real set**, that's the clearest single signal that `downFraction` is set too deep for how your body looks to this camera.

---

## Honest scope: what works now, and the trade-offs behind it

**Front-facing push-ups now count.** That was the big goal of this pass, and it's the headline change: by moving to BlazePose's estimated depth, a push-up facing the camera straight on now registers through the depth part of the combined signal, instead of being invisible to a flat 2D picture. Side-on and angled views keep working the same way they did (mostly through the vertical part), so in plain terms the app now counts push-ups from the front, the left, or the right.

**What works now:**
1. **Any-viewpoint push-ups.** The combined vertical-and-depth signal counts a rep whether the movement is mostly down the screen (side-on) or mostly toward the lens (head-on).
2. **Walking and standing still don't count.** The anti-standing guard now judges "head above shoulders" in real-world 3D when depth is available, so it still rejects a standing or walking bob *and* no longer falsely rejects a legitimate front-facing head-up plank.
3. **The debug readout and diagnostics report** show the real detector numbers live and per-set, now split into the vertical and depth parts, so thresholds get tuned from real data.

**The honest trade-offs we accepted to get here:**
- **Estimated, not measured, depth.** A single webcam has no depth sensor, so the z is BlazePose's best guess from one flat picture. It's enough to tell "toward the lens" from "away", but it's noisier than the on-screen x/y, which is why the smoothing, hysteresis, confidence gating and locked rulers all matter even more now.
- **BlazePose is heavier than MoveNet.** The model is bigger, so first-load can take a little longer and each frame costs a little more work. We default to the lightest `lite` variant to protect the frame rate; if front-facing depth looks too noisy on a capable machine, `full` is the quality lever. Keep an eye on load time and per-frame smoothness when tuning.
- **Single-camera depth is noisier head-on than side-on.** When depth is the part carrying the rep, expect more jitter in the z number than you'd see in the clean side-on vertical signal. The debug readout splits the two parts out precisely so you can see this and tune for it.

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
│   │   ├── angles.js            #   the joint-angle math (sit-ups)
│   │   ├── keypointAdapter.js   #   keeps joints by name + attaches estimated depth z
│   │   ├── upperBodySignal.js   #   combined vertical + depth signal + body-scale (push-ups)
│   │   ├── repCounter.js        #   the angle-based down-then-up state machine (sit-ups)
│   │   ├── verticalRepCounter.js #  the position-based down-then-up state machine (push-ups)
│   │   ├── exercises.js         #   exercise + difficulty definitions
│   │   ├── workoutQueue.js      #   chaining multiple workouts in order
│   │   ├── pushupDiagnostics.js #   per-set recorder for the diagnostics report
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
