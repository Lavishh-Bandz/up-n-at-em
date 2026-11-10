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

> **First run needs internet.** The pose-detection model (the thing that finds your body) downloads its "brain" from the web the first time the page loads. After that it's cached.

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

**2. A pose-detection model finds your joints.** We use a model called **MoveNet**. For each video frame it returns the pixel positions of 17 body "keypoints": your shoulders, elbows, wrists, hips, knees, and so on. Think of it as the model dropping a labeled dot on each joint.

**3. We turn those joints into one simple number to watch.** You don't need all 17 joints to count a rep, just enough to see the movement. The two exercises watch different things, because they move in different ways:
   - **Push-ups:** we watch your **visible upper body move down toward the floor and back up**. Specifically we track the vertical position of your shoulder (and your nose too, when the camera can see it), so the number follows your head-and-shoulders block dipping down at the bottom of a push-up and rising back up at the top. **We do *not* use your elbows, wrists, hips or legs.** This is a deliberate change: a normal webcam physically *cannot fit your whole body* when you're down doing a floor push-up, so the old approach (which measured the elbow angle and needed your elbow, wrist *and* hip all in frame) left real users counting zero. Watching just the upper body means it keeps counting even when your legs and hips are out of frame — which, on a webcam, they almost always are.
   - **Sit-ups:** we measure the **hip / torso angle** (shoulder → hip → knee). Lying flat ≈ wide open, sitting up ≈ folded shut. Nothing about sit-ups changed; when you're sitting up your whole body fits in frame fine.

   For push-ups, "how far did you move?" can't be counted in raw pixels, because someone close to the camera looks huge and moves hundreds of pixels while someone far away looks tiny and moves only a few. So we measure the dip as a **fraction of your own body size** — specifically your shoulder width in pixels (with a nose-to-shoulder fallback if only one shoulder shows). As a fraction of your own body, a real push-up looks the same whether you're near or far. That body-scale math lives in [`src/logic/upperBodySignal.js`](src/logic/upperBodySignal.js).

   > **The ruler is locked once, not measured every frame.** There's a subtle trap here that caused real push-ups to go uncounted. If we re-measured your shoulder width *every single frame* and divided by it, the ruler itself would be moving while we tried to measure against it. Facing the camera this is really bad: as you go down into a push-up your shoulders rotate and tuck and your torso gets closer to the lens, so the apparent shoulder width *swings* through the rep. Dividing a real dip by a shrinking and growing ruler means a genuine rep can fail to cross the threshold cleanly while random noise sometimes does. The fix is to measure the ruler **once** and then leave it alone: during the 5-second get-into-position countdown (5d), while you're holding still at the top, we take a smoothed average of your body size and **lock** that single value as the ruler for the whole set. After that the only thing changing frame to frame is your actual vertical movement, which is exactly what we want to measure. This stable-ruler logic is the pure `createBodyScaleTracker` in [`src/logic/upperBodySignal.js`](src/logic/upperBodySignal.js); if the lock somehow never captured a usable value it quietly falls back to the live per-frame measurement for that frame.

   The camera only ever sees one side of you clearly, so each frame we check **both your left and right side** and use whichever one the camera can see best. That means it doesn't matter which way you face: if your left shoulder is hidden behind your body, the app automatically tracks your right shoulder instead. The "pick the more visible side" logic lives in [`src/logic/exercises.js`](src/logic/exercises.js) (`pickBetterSide`), and the math for "the angle at a corner given three points" (used by sit-ups) lives in [`src/logic/angles.js`](src/logic/angles.js), with the geometry explained in plain comments.

**4. We count a rep on a full down-then-up movement.** A little state machine watches the number:
   - It starts in the **up** position (push-up: upper body high / sit-up: lying flat).
   - When you move *past* a "down" threshold (push-up: your upper body dips far enough toward the floor / sit-up: your torso folds shut enough), it switches to the **down** state.
   - When you come back *past* an "up" threshold (push-up: your upper body rises back up / sit-up: you lie back flat), that's **one rep**, and it flips back to **up**.

   There are two different thresholds on purpose (a technique called *hysteresis*). If we used a single line, tiny wobbles while you hold a position would rack up dozens of fake reps. The gap between the two thresholds means you have to make a real, full movement for a rep to count. Sit-ups use the angle-based state machine in [`src/logic/repCounter.js`](src/logic/repCounter.js); push-ups use the position-based one in [`src/logic/verticalRepCounter.js`](src/logic/verticalRepCounter.js), which measures the down-then-up dip against an adaptive "resting" baseline so it keeps up as you shift around.

   > **The honest trade-off.** Watching the upper body's *position* is a little less precise than reading a clean side-profile *elbow angle* — position can't tell a deep push-up from a shallow one quite as sharply as a bending elbow can. We accept that on purpose, because the position approach is the only one that actually fits inside a real webcam's field of view. Three things keep it trustworthy anyway: the **smoothing** (5c), the **two-threshold hysteresis** (above), and the **5-second get-into-position countdown** (5d), which together reject jitter and casual bobbing while still counting genuine reps.

**5. Anti-cheat, part 1: no valid pose, no counting.** Every keypoint comes with a confidence score (how sure the model is it really sees that joint). If the joints we need for the current exercise aren't clearly visible (you're off-screen, the lighting is bad, you're trying to fake it with your hand), the counter simply *ignores* those frames and won't advance. You can't earn reps the camera can't actually verify.

**5b. Anti-cheat, part 2: you can't fake it by bobbing.** Counting a down-then-up movement on its own isn't quite enough. The worry is that you just *stand there and bob up and down* a little to fake push-ups.

   For **sit-ups**, we add a light **horizontal** sanity check: we look at the tilt of the line from your shoulder to your hip (lying flat is near 0°, standing is near 90°) and rule out an obviously fully-standing body. The threshold is forgiving on purpose — your torso tilts up a lot at the top of a sit-up — so it only rejects someone who is clearly standing. This lives in `isBodyHorizontal` / `evaluateOrientation` in [`src/logic/angles.js`](src/logic/angles.js) and [`src/logic/exercises.js`](src/logic/exercises.js).

   For **push-ups** we deliberately do *not* use that shoulder-to-hip check anymore. The hip is exactly the keypoint a webcam can't fit during a floor push-up, so requiring it would re-break counting for the very users this redesign is meant to help. Instead there's a dedicated **upper-body-only anti-standing guard** that looks at the shoulders, nose and wrists, and never asks to see your hip or legs. It uses two cues:

   - **Your head isn't stacked high above your shoulders.** When you stand tall, your nose sits *far* above your shoulder line; when you're down in a push-up or plank, your head drops forward and your head and shoulders are much closer to level. So if the nose is more than a set fraction of a body-size *above* the shoulder, the guard calls it "standing" and rejects the frame. This one cue works whether the camera sees you head-on *or* from the side, because it only needs your nose and one shoulder. The starting threshold is `uprightNoseFraction` = 0.6 of a body-size.
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

- **dip (smoothed) / need** — the normalized dip the counter actually saw this frame (after smoothing), next to the `downFraction` it has to reach to go "down". This is the single most important pair: for a rep to start, the left number has to climb past the right one.
- **raw dip** — the same dip *before* smoothing, so you can compare how much the moving average calmed it down.
- **up threshold** — the smaller `upFraction` the dip has to shrink back past to complete the rep.
- **bodyScale** — the ruler actually in use, in pixels, tagged `(locked)` once the 5-second countdown locked it or `(live)` before then.
- **upperY** — the raw upper-body y (pixels) the signal is tracking.
- **confident** — whether the joints we need were clearly visible this frame (anti-cheat part 1).
- **armed** — whether the 5-second get-into-position countdown has finished and counting is live.
- **phase** — the state machine's current phase, `up` or `down`.
- **posture** — what the anti-standing guard decided: `ok` (looks like a push-up) or `standing` (rejected).
- **reps** — the running count.

**The diagnostics report** is your "way to watch the video" without a webcam in front of us. The moment a push-up set *arms* (the "GO!" moment), a recorder starts capturing those same per-frame numbers side by side with the thresholds they're aiming for. When the set finishes (or you emergency-exit), the report is available two ways: an **expandable block on screen** (click "Show report" to reveal the full JSON in a text box you can copy) and the same JSON **logged to the browser console**. It carries every (capped) sample plus a short summary, including `summary.downFractionReached` — whether the smoothed dip ever reached the "down" threshold during the set. The recorder is the pure `createPushupDiagnostics` in [`src/logic/pushupDiagnostics.js`](src/logic/pushupDiagnostics.js); the on-screen panel is [`src/components/DebugReadout.jsx`](src/components/DebugReadout.jsx).

**How you actually use these to tune.** You read the numbers back to us and we set the thresholds from real data instead of guessing. The concrete levers:

- If a real rep's **dip (smoothed) never reaches the "need" value**, that difficulty's `downFraction` is too deep: lower it. (The starting values are `easy` 0.12, `standard` 0.16, `hard` 0.22, with matching `upFraction` 0.05 / 0.06 / 0.08, in [`src/logic/exercises.js`](src/logic/exercises.js).)
- If **posture shows "standing" during a real push-up**, the upright test is too strict: raise `uprightNoseFraction` (starting value 0.6).
- If **`summary.downFractionReached` is `false` after a real set**, that's the clearest single signal that `downFraction` is set too deep for how your body looks to this camera.

---

## Honest scope: what this pass guarantees, and what's deferred

This fix pass was aimed at three specific, must-work outcomes, and it's worth being clear about where the line is:

**Delivered this pass:**
1. **The debug readout and diagnostics report.** You can see the real detector numbers live on screen and capture a full report per set, so thresholds get tuned from real data.
2. **Walking and standing no longer count.** The upper-body-only anti-standing guard rejects a standing or walking bob (head high above the shoulders, or clearly-visible wrists that aren't planted and still) before any dip can start a rep.
3. **A clean side-view push-up counts reliably.** The stable locked ruler plus the shallower, reachable starting thresholds mean a genuine push-up filmed from the side crosses the "down" threshold and counts.

**Only partially addressed, and deferred to its own follow-up pass: full head-on front-facing detection.** When you face the camera straight on, the hardest part is that a push-up is mostly movement *toward and away from the lens* (depth), and a flat camera picture can't see depth directly. The stable ruler and the upper-body guard help, but reliably counting a head-on push-up really needs its own approach, and we'd rather name it as a clear next step than half-build it now. The likely direction: instead of watching vertical pixels, watch your **apparent body size grow and shrink**. As you lower toward the floor facing the camera you get *closer* to the lens, so you look slightly *bigger*; as you push back up you move *away* and look slightly *smaller*. That change in apparent size is a depth proxy the camera *can* measure, and pairing it with the vertical signal is the sensible way to make front-facing reps count. That's a focused piece of work on its own, so it's parked here as the documented next step rather than quietly shipped half-done.

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
│   │   ├── upperBodySignal.js   #   upper-body position + body-scale (push-ups)
│   │   ├── repCounter.js        #   the angle-based down-then-up state machine (sit-ups)
│   │   ├── verticalRepCounter.js #  the position-based down-then-up state machine (push-ups)
│   │   ├── exercises.js         #   exercise + difficulty definitions
│   │   ├── workoutQueue.js      #   chaining multiple workouts in order
│   │   └── __tests__/           #   Vitest tests for all of the above
│   ├── hooks/
│   │   ├── usePoseDetector.js  # loads MoveNet, runs the detection loop
│   │   └── useAlarm.js         # the looping Web Audio alarm tone
│   └── components/
│       ├── CameraView.jsx      # webcam + skeleton overlay
│       ├── SettingsPanel.jsx   # build your workout
│       ├── ProgressHud.jsx     # live rep count + progress
│       ├── EmergencyExit.jsx   # the hold-to-cancel escape
│       └── WorkoutSession.jsx  # wires the camera to the rep-counting logic
└── src/stubs/mediapipe-pose.js # small build shim (see below)
```

> **One build note for the curious:** `vite.config.js` contains a small alias that points `@mediapipe/pose` at a tiny stub file. The pose-detection library references that package even though we only use MoveNet (which doesn't need it), and the real package doesn't bundle cleanly. The stub keeps the build working and is intentional, please don't remove it.

---

## The alarm sound

There's no audio file in this repo. The alarm tone is **generated in code** using the browser's Web Audio API (a pulsing square-wave beep). That keeps the project small (nothing big to download) and avoids any audio licensing questions. See [`src/hooks/useAlarm.js`](src/hooks/useAlarm.js).
