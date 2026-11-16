// usePoseDetector.js
// -----------------------------------------------------------------------------
// A React hook that runs pose detection on a live <video> element.
//
// WHAT IT DOES, STEP BY STEP:
//   1. Loads TensorFlow.js and tells it to use the fast WebGL backend (the GPU).
//   2. Creates a BlazePose detector using the pure-JS "tfjs" runtime. BlazePose
//      is a 3D-capable model: for every frame it returns the usual 2D joints
//      (pixel x/y + score) AND a 3D estimate ("keypoints3D") that includes
//      DEPTH (how far each joint is toward/away from the camera). Depth is what
//      lets us count a push-up from the front, where the body barely moves on
//      screen but clearly moves toward/away from the lens.
//        - modelType 'lite' is the DEFAULT here: BlazePose is heavier than the
//          old MoveNet SinglePose-Lightning, and 'lite' keeps the per-frame
//          cost low enough for a smooth requestAnimationFrame loop.
//        - 'full' (and 'heavy') exist as higher-QUALITY fallbacks if accuracy
//          ever matters more than frame rate; swap modelType to try them.
//      Like MoveNet, the model WEIGHTS download from tfhub.dev on FIRST RUN in
//      the browser (so first launch needs internet); this is a runtime-only
//      download and does not affect the headless build.
//   3. Starts a requestAnimationFrame loop. On every animation frame it asks
//      the detector "where are this person's joints right now?", merges the 2D
//      and 3D results into one name-keyed map (see keypointAdapter.js), and
//      stores the answer.
//   4. Exposes the latest keypoints (keyed by BlazePose joint name, e.g.
//      keypoints.left_elbow — each entry carries pixel x/y + score AND a depth
//      z) plus a status string: 'loading' | 'ready' | 'error'.
//   5. Cleans everything up on unmount: cancels the animation loop and disposes
//      the detector so the GPU memory is released.
//
// WHY THE tfjs RUNTIME (not the mediapipe one): the tfjs BlazePose runtime is
// self-contained and does NOT import '@mediapipe/pose', so the existing
// vite.config.js stub alias stays valid and the build stays clean. It also
// reuses the WebGL backend we already set up below, same as MoveNet did.
//
// HEADLESS NOTE: this hook only does real work inside a browser with WebGL and
// a camera. In a plain Node/test environment there is no window/rAF, so the
// loop simply never starts. That keeps the build and unit tests happy.

import { useEffect, useRef, useState } from 'react';
import * as poseDetection from '@tensorflow-models/pose-detection';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
import { buildKeypointMap } from '../logic/keypointAdapter.js';

/**
 * Run BlazePose on a video element.
 *
 * @param {React.RefObject<HTMLVideoElement>} videoRef  Ref to the <video> we read frames from.
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] When false, detection does not run
 *                                         (useful before the session starts).
 * @param {(keypointsMap:object) => void} [options.onPose] Optional callback
 *                                         fired every frame with the latest
 *                                         keypoints-by-name map. Handy for
 *                                         feeding the rep counter without
 *                                         waiting for a React re-render.
 * @returns {{status:'loading'|'ready'|'error', error:(Error|null), keypoints:object}}
 */
export function usePoseDetector(videoRef, { enabled = true, onPose } = {}) {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  // Latest keypoints-by-name map, exposed for rendering the overlay.
  const [keypoints, setKeypoints] = useState({});

  // Refs hold values that must survive re-renders without causing one.
  const detectorRef = useRef(null);
  const rafRef = useRef(null);
  // Keep the latest onPose in a ref so changing it does not restart the loop.
  const onPoseRef = useRef(onPose);
  onPoseRef.current = onPose;

  // DIAGNOSTIC (temporary): a one-shot guard so we dump the RAW model output to
  // the console exactly ONCE per mount, not every animation frame. Two earlier
  // fix attempts failed with the same fingerprint (bodyScalePx null while
  // depthScaleM has a value), which means our assumptions about the shape
  // BlazePose's tfjs runtime actually returns are wrong. Rather than guess a
  // third time, we print the first real pose BEFORE buildKeypointMap touches it
  // so the user can copy the ground truth back to us. Flipping this ref to true
  // the first time silences the dump for the rest of the session.
  const rawDumpedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    async function setup() {
      try {
        // Pick the GPU-backed backend and wait until it is ready.
        await tf.setBackend('webgl');
        await tf.ready();

        // Create the single-person 3D detector. 'lite' keeps the rAF loop
        // smooth; enableSmoothing softens frame-to-frame jitter in the joints.
        const detector = await poseDetection.createDetector(
          poseDetection.SupportedModels.BlazePose,
          { runtime: 'tfjs', modelType: 'lite', enableSmoothing: true }
        );
        if (cancelled) {
          detector.dispose();
          return;
        }
        detectorRef.current = detector;
        setStatus('ready');

        // The per-frame loop: estimate the pose, store it, schedule the next.
        const loop = async () => {
          const video = videoRef.current;
          const detectorNow = detectorRef.current;

          // Only estimate when the video actually has a frame to read.
          if (
            detectorNow &&
            video &&
            video.readyState >= 2 && // HAVE_CURRENT_DATA or better
            !video.paused
          ) {
            try {
              const poses = await detectorNow.estimatePoses(video, {
                maxPoses: 1,
                flipHorizontal: false,
              });
              // DIAGNOSTIC (temporary): on the FIRST frame that actually
              // returns a pose, print the raw result exactly as the model gave
              // it to us, BEFORE buildKeypointMap reshapes anything. We log the
              // array-ness + lengths of both lists, the full raw nose (index 0)
              // and both shoulders (indexes 11 + 12) from the 2D list, the two
              // raw shoulders from the 3D list, and the video size at this exact
              // moment. videoWidth/videoHeight matter because the 2D x/y come
              // back as NORMALIZED 0..1 values multiplied by the video size, so
              // if the video reports 0x0 here every 2D x/y collapses to 0 and
              // the pixel ruler (bodyScalePx) would read null while the 3D
              // world landmarks (meters, size-independent) still work. The dump
              // is wrapped in its own try/catch so a logging slip can never
              // disturb the detection loop. (The "countdown counts down even
              // when not in position" symptom is almost certainly the SAME root
              // cause: the arming gate is fed confidence derived from these 2D
              // keypoints, so if the 2D side is broken the gate misbehaves. We
              // will re-check that once this dump reveals the real 2D shape.)
              if (!rawDumpedRef.current && poses && poses[0]) {
                rawDumpedRef.current = true;
                try {
                  const rawPose = poses[0];
                  const kp = rawPose.keypoints;
                  const kp3d = rawPose.keypoints3D;
                  const snapshot = {
                    keypointsIsArray: Array.isArray(kp),
                    keypointsLength: Array.isArray(kp) ? kp.length : null,
                    keypoints3DIsArray: Array.isArray(kp3d),
                    keypoints3DLength: Array.isArray(kp3d) ? kp3d.length : null,
                    poseScore: rawPose.score,
                    // Full raw 2D entries for nose + both shoulders (by index).
                    keypoints_0_nose: Array.isArray(kp) ? kp[0] : null,
                    keypoints_11_left_shoulder: Array.isArray(kp) ? kp[11] : null,
                    keypoints_12_right_shoulder: Array.isArray(kp) ? kp[12] : null,
                    // Full raw 3D entries for both shoulders (by index).
                    keypoints3D_11_left_shoulder: Array.isArray(kp3d) ? kp3d[11] : null,
                    keypoints3D_12_right_shoulder: Array.isArray(kp3d) ? kp3d[12] : null,
                    // Video size right now: the multiplier for the 2D pixels.
                    videoWidth: video.videoWidth,
                    videoHeight: video.videoHeight,
                  };
                  // One stable, greppable label + JSON so the user can copy it.
                  console.log(
                    '[UP N AT EM] RAW BLAZEPOSE FRAME',
                    JSON.stringify(snapshot)
                  );
                } catch (dumpErr) {
                  // Never let the diagnostic break detection; just note it.
                  console.log(
                    '[UP N AT EM] RAW BLAZEPOSE FRAME dump failed',
                    String(dumpErr)
                  );
                }
              }

              if (!cancelled) {
                // Merge the 2D (pixel x/y + score) and 3D (depth z) results
                // into one name-keyed map. See keypointAdapter.js for the exact
                // shape and units (x/y pixels, z meters; smaller z = closer to
                // the camera).
                const map = poses && poses[0] ? buildKeypointMap(poses[0]) : {};
                setKeypoints(map);
                if (onPoseRef.current) onPoseRef.current(map);
              }
            } catch {
              // A single bad frame should not kill the loop; just skip it.
            }
          }

          if (!cancelled) {
            rafRef.current = requestAnimationFrame(loop);
          }
        };

        rafRef.current = requestAnimationFrame(loop);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setStatus('error');
        }
      }
    }

    setup();

    // CLEANUP: stop the loop and free the detector/GPU memory.
    return () => {
      cancelled = true;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (detectorRef.current) {
        detectorRef.current.dispose();
        detectorRef.current = null;
      }
    };
    // videoRef is a stable ref object; enabled toggles the whole lifecycle.
  }, [enabled, videoRef]);

  return { status, error, keypoints };
}

export default usePoseDetector;
