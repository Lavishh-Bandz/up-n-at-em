// usePoseDetector.js
// -----------------------------------------------------------------------------
// A React hook that runs pose detection on a live <video> element.
//
// WHAT IT DOES, STEP BY STEP:
//   1. Loads TensorFlow.js and tells it to use the fast WebGL backend (the GPU).
//   2. Creates a MoveNet detector in "SinglePose Lightning" mode. Lightning is
//      the small, fast model: perfect for counting one person's reps in real
//      time in a browser.
//   3. Starts a requestAnimationFrame loop. On every animation frame it asks
//      the detector "where are this person's joints right now?" and stores the
//      answer.
//   4. Exposes the latest keypoints (keyed by MoveNet joint name, e.g.
//      keypoints.left_elbow) plus a status string: 'loading' | 'ready' |
//      'error'.
//   5. Cleans everything up on unmount: cancels the animation loop and disposes
//      the detector so the GPU memory is released.
//
// HEADLESS NOTE: this hook only does real work inside a browser with WebGL and
// a camera. In a plain Node/test environment there is no window/rAF, so the
// loop simply never starts. That keeps the build and unit tests happy.

import { useEffect, useRef, useState } from 'react';
import * as poseDetection from '@tensorflow-models/pose-detection';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';

/**
 * Turn MoveNet's array of keypoints into a plain object keyed by joint name,
 * so callers can do `keypoints.left_elbow` instead of searching an array.
 *
 * @param {Array<{name?:string, x:number, y:number, score?:number}>} keypoints
 * @returns {Object<string, {x:number, y:number, score:number}>}
 */
function keypointsByName(keypoints) {
  const map = {};
  for (const kp of keypoints) {
    if (kp && kp.name) {
      map[kp.name] = kp;
    }
  }
  return map;
}

/**
 * Run MoveNet on a video element.
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

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    async function setup() {
      try {
        // Pick the GPU-backed backend and wait until it is ready.
        await tf.setBackend('webgl');
        await tf.ready();

        // Create the fast single-person detector.
        const detector = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
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
              if (!cancelled) {
                const map =
                  poses && poses[0] ? keypointsByName(poses[0].keypoints) : {};
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
