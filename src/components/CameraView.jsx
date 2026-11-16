// CameraView.jsx
// -----------------------------------------------------------------------------
// Shows the live webcam feed and draws a "skeleton" over the person: dots on
// each detected joint and lines connecting joints that are next to each other
// (shoulder-to-elbow, elbow-to-wrist, and so on).
//
// HOW IT FITS TOGETHER:
//   - A <video> element plays the camera stream.
//   - A <canvas> sits exactly on top of the video (same size, same position).
//   - usePoseDetector watches the video and gives us keypoints every frame.
//   - Each frame we clear the canvas and redraw the skeleton from those points.
//
// The parent (WorkoutSession) owns the rep-counting logic. We just forward the
// keypoints up via onPose so the parent can feed them into the rep counter.

import { useEffect, useRef, useState } from 'react';
import * as poseDetection from '@tensorflow-models/pose-detection';
import { usePoseDetector } from '../hooks/usePoseDetector.js';

// Only draw joints/lines the detector is reasonably sure about. This matches
// the anti-cheat idea: faint guesses are not drawn.
const DRAW_THRESHOLD = 0.3;

// The pairs of joints that should be joined by a line to look like a skeleton.
// We ask pose-detection for MoveNet's official adjacency list; if that ever
// fails we fall back to a hand-written list so the overlay still works.
function getSkeletonPairs() {
  try {
    // Returns pairs of keypoint INDEXES, e.g. [5, 7] = left_shoulder-left_elbow.
    return poseDetection.util.getAdjacentPairs(
      poseDetection.SupportedModels.MoveNet
    );
  } catch {
    // MoveNet keypoint index order (COCO): 0 nose, 1/2 eyes, 3/4 ears,
    // 5/6 shoulders, 7/8 elbows, 9/10 wrists, 11/12 hips, 13/14 knees,
    // 15/16 ankles.
    return [
      [5, 7], [7, 9], [6, 8], [8, 10],   // arms
      [5, 6], [5, 11], [6, 12], [11, 12], // torso
      [11, 13], [13, 15], [12, 14], [14, 16], // legs
    ];
  }
}

// MoveNet always returns its 17 keypoints in this fixed order, so we can map an
// index from the adjacency list back to a joint name to look it up in the map.
const MOVENET_KEYPOINT_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];

// The camera settings we'd LIKE: a high-resolution frame from a front-facing
// camera. Every value is `ideal` (a wish, not a demand) so a camera that can't
// match it exactly still returns its closest mode rather than failing.
//
// IMPORTANT LESSON (why there is NO aspectRatio here anymore):
//   An earlier version asked for aspectRatio { ideal: 16/9 }. That BACKFIRED on
//   a plain external USB webcam. Most simple webcams have a 4:3 sensor (like
//   640×480 or 1280×960). When you demand a 16:9 picture from a 4:3 sensor, the
//   camera can only obey by CROPPING OFF the top and bottom of its real view —
//   so you get a zoomed-in 16:9 slice, NOT the full wide picture. That made the
//   app look MORE zoomed than the camera's true field of view.
//   The fix: do NOT force an aspect ratio. We ask only for a resolution and let
//   the camera hand back its OWN natural shape (its full, uncropped frame). We
//   then size the on-screen box to match whatever shape it gives us.
const WIDE_VIDEO_CONSTRAINTS = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  // `ideal`, not a plain string, so a front camera is only a PREFERENCE — a
  // single external USB camera is still accepted when there's no choice.
  facingMode: { ideal: 'user' },
};

// Ask for the camera with our wide (but un-cropped) constraints, but don't let
// a fussy camera lock us out: if the detailed request fails for a reason that
// ISN'T "permission denied" or "no camera" (for example an OverconstrainedError
// because the webcam dislikes those exact numbers), we quietly retry once with
// the simple { video: true } request so the app still works. Permission and
// not-found errors are re-thrown so the caller can show its friendly message.
async function getCameraStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: WIDE_VIDEO_CONSTRAINTS,
    });
  } catch (err) {
    const name = err && err.name;
    // These are real "the user/hardware said no" errors. Don't paper over them
    // with a fallback; let the caller translate them into a friendly message.
    if (
      name === 'NotAllowedError' ||
      name === 'SecurityError' ||
      name === 'NotFoundError'
    ) {
      throw err;
    }
    // Otherwise the camera just didn't like our detailed constraints. Fall back
    // to the plain request so we still get a stream (even if it's the narrower
    // default mode) rather than failing outright.
    return navigator.mediaDevices.getUserMedia({ video: true });
  }
}

/**
 * @param {object} props
 * @param {boolean} props.active        Whether a session is running (drives detection).
 * @param {(keypointsMap:object) => void} [props.onPose]  Called each frame with keypoints-by-name.
 */
export default function CameraView({ active, onPose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  // Camera permission / hardware errors we want to show the user clearly.
  const [cameraError, setCameraError] = useState(null);

  // The REAL frame size the camera actually gave us, filled in once the video
  // reports its metadata. We use it for two things:
  //   1) a tiny on-screen readout ("Camera: 640×480") so we can SEE the true
  //      capture size instead of guessing whether it "looks zoomed", and
  //   2) the on-screen box's shape, so the container matches the camera's own
  //      aspect ratio (no forced crop, no awkward letterbox).
  // `null` until we know; the readout and the custom box shape wait for it.
  const [cameraDimensions, setCameraDimensions] = useState(null);

  // Run pose detection against the video while the session is active.
  const { status, error: detectorError, keypoints } = usePoseDetector(videoRef, {
    enabled: active,
    onPose,
  });

  // ---- 1. Acquire the webcam and attach it to the <video> ------------------
  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      // Guard for environments without a camera API (e.g. headless/SSR).
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError('This browser does not support camera access.');
        return;
      }
      try {
        // We ask for a high resolution but DON'T force an aspect ratio (see
        // WIDE_VIDEO_CONSTRAINTS above). Asking for a big resolution nudges the
        // camera toward its fuller, less-cropped mode so there's room to see
        // your whole body — but because we no longer demand 16:9, a 4:3 webcam
        // returns its WHOLE 4:3 picture instead of a cropped 16:9 slice of it.
        //
        // Everything uses `ideal` (not `exact`) on purpose: `ideal` is a
        // preference, so a camera that can't hit these exact numbers still
        // returns its closest mode instead of throwing an error.
        const stream = await getCameraStream();
        if (cancelled) {
          // We unmounted while waiting for permission; stop the stream.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          const video = videoRef.current;
          video.srcObject = stream;

          // Once the browser knows the real frame size, record it. We prefer
          // the <video> element's own videoWidth/videoHeight (the exact pixels
          // being decoded), and fall back to the track's reported settings if
          // the video numbers aren't ready yet. This is the honest capture
          // size — the same shape we'll make the on-screen box so nothing is
          // cropped and the skeleton overlay stays lined up with the body.
          const recordDimensions = () => {
            if (cancelled) return;
            let width = video.videoWidth;
            let height = video.videoHeight;
            if (!width || !height) {
              // Fall back to what the camera TRACK reports it's sending.
              const track = stream.getVideoTracks()[0];
              const settings = track ? track.getSettings() : {};
              width = settings.width || width;
              height = settings.height || height;
            }
            if (width && height) {
              setCameraDimensions({ width, height });
            }
          };
          // `loadedmetadata` fires as soon as width/height are known.
          video.addEventListener('loadedmetadata', recordDimensions);

          await video.play().catch(() => {});
          // In case metadata was already available before we attached the
          // listener (fast cameras), read it once right now too.
          recordDimensions();
        }
      } catch (err) {
        // Translate the browser's error into a friendly message.
        let message = 'Could not access the camera.';
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
          message =
            'Camera permission was denied. Please allow camera access and reload to use UP N AT EM.';
        } else if (err && err.name === 'NotFoundError') {
          message = 'No camera was found on this device.';
        }
        if (!cancelled) setCameraError(message);
      }
    }

    startCamera();

    // CLEANUP: stop every track so the camera light turns off on unmount.
    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, []);

  // ---- 2. Draw the skeleton overlay whenever keypoints change --------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    // Match the canvas pixel size to the actual video frame size so the drawn
    // joints line up exactly with the image underneath.
    const width = video.videoWidth || canvas.width;
    const height = video.videoHeight || canvas.height;
    if (width && height && (canvas.width !== width || canvas.height !== height)) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw the connecting lines (bones).
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#38bdf8';
    for (const [i, j] of getSkeletonPairs()) {
      const a = keypoints[MOVENET_KEYPOINT_NAMES[i]];
      const b = keypoints[MOVENET_KEYPOINT_NAMES[j]];
      if (a && b && a.score >= DRAW_THRESHOLD && b.score >= DRAW_THRESHOLD) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Draw the joints (dots) on top of the lines.
    ctx.fillStyle = '#f472b6';
    for (const name of MOVENET_KEYPOINT_NAMES) {
      const kp = keypoints[name];
      if (kp && kp.score >= DRAW_THRESHOLD) {
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, 5, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }, [keypoints]);

  // ---- 3. Render -----------------------------------------------------------
  if (cameraError) {
    return (
      <div className="camera-error" role="alert">
        <p>📷 {cameraError}</p>
      </div>
    );
  }

  // Shape the on-screen box to match the camera's REAL frame once we know it.
  // Before that we leave it to the CSS default. Setting the container's
  // aspect-ratio to the true width/height means the box is exactly the shape of
  // the picture, so `object-fit: contain` shows the WHOLE frame with no crop
  // and (because the shapes match) no black letterbox bars either. The canvas
  // overlay shares the same box and the same fit, so the skeleton stays aligned.
  const boxStyle = cameraDimensions
    ? { aspectRatio: `${cameraDimensions.width} / ${cameraDimensions.height}` }
    : undefined;

  return (
    <div className="camera-view" style={boxStyle}>
      {/* The video and canvas are stacked; CSS positions the canvas on top. */}
      <video ref={videoRef} className="camera-video" playsInline muted />
      <canvas ref={canvasRef} className="camera-overlay" />

      {/* Tiny readout of the REAL capture size, so "it looks zoomed" becomes a
          concrete number we can tune against. Shown as soon as we know it. */}
      {cameraDimensions && (
        <p className="camera-status">
          Camera: {cameraDimensions.width}×{cameraDimensions.height}
        </p>
      )}

      {/* Small status line so the user knows the model is warming up. */}
      {status === 'loading' && (
        <p className="camera-status camera-status-model">Loading pose detector…</p>
      )}
      {status === 'error' && (
        <p className="camera-status camera-status-model camera-status-error">
          Pose detector failed to load
          {detectorError ? `: ${detectorError.message}` : '.'}
        </p>
      )}
    </div>
  );
}
