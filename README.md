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

**3. We measure a single joint angle.** You don't need all 17 joints to count a push-up, just the ones that bend:
   - **Push-ups:** we measure the **elbow angle** (the corner formed by your shoulder → elbow → wrist). Arms straight ≈ 180°, elbow bent at the bottom ≈ 90°.
   - **Sit-ups:** we measure the **hip / torso angle** (shoulder → hip → knee). Lying flat ≈ wide open, sitting up ≈ folded shut.

   The math for "the angle at a corner given three points" lives in [`src/logic/angles.js`](src/logic/angles.js), with the geometry explained in plain comments.

**4. We count a rep on a full down-then-up movement.** A little state machine watches the angle:
   - It starts in the **up** position (e.g. arms straight).
   - When you bend *past* a "down" threshold, it switches to the **down** state.
   - When you straighten back *past* an "up" threshold, that's **one rep**, and it flips back to **up**.

   There are two different thresholds on purpose (a technique called *hysteresis*). If we used a single line, tiny wobbles while you hold a position would rack up dozens of fake reps. The gap between the two thresholds means you have to make a real, full movement for a rep to count. This logic is in [`src/logic/repCounter.js`](src/logic/repCounter.js).

**5. Anti-cheat: no valid pose, no counting.** Every keypoint comes with a confidence score (how sure the model is it really sees that joint). If the joints we need for the current exercise aren't clearly visible (you're off-screen, the lighting is bad, you're trying to fake it with your hand), the counter simply *ignores* those frames and won't advance. You can't earn reps the camera can't actually verify.

**6. Difficulty changes the thresholds.** "Hard" demands a deeper range of motion (you have to bend further down and straighten further up) and sets a higher default rep count, 45 push-ups for example. "Easy" is more forgiving. The presets live in [`src/logic/exercises.js`](src/logic/exercises.js).

**7. Multiple workouts chain in order.** If you set "45 push-ups then 30 sit-ups", the alarm only stops once *both* steps hit their targets, in order. That progression is tracked in [`src/logic/workoutQueue.js`](src/logic/workoutQueue.js).

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
│   │   ├── angles.js       #   the joint-angle math
│   │   ├── repCounter.js   #   the down-then-up rep state machine
│   │   ├── exercises.js    #   exercise + difficulty definitions
│   │   ├── workoutQueue.js #   chaining multiple workouts in order
│   │   └── __tests__/      #   Vitest tests for all of the above
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
