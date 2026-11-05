// EmergencyExit.jsx
// -----------------------------------------------------------------------------
// The HONEST safety hatch. Locking an alarm behind exercise could trap someone
// who is injured, needs the bathroom, or has a real emergency. So we provide a
// deliberate, hard-to-trigger-by-accident way out: press and HOLD the button
// for ~3 seconds.
//
// The hold requirement means you cannot silence the alarm with a careless tap
// (which would defeat the whole point), but you always have a real exit.
//
// While held, we animate a progress bar so the user can see the countdown.

import { useRef, useState } from 'react';

const HOLD_MS = 3000; // how long you must hold to trigger the escape

export default function EmergencyExit({ onCancel }) {
  const [progress, setProgress] = useState(0); // 0..1 fill of the hold bar
  const rafRef = useRef(null);
  const startRef = useRef(0);

  function tick() {
    const elapsed = Date.now() - startRef.current;
    const ratio = Math.min(1, elapsed / HOLD_MS);
    setProgress(ratio);
    if (ratio >= 1) {
      // Held long enough: trigger the escape.
      stopHolding();
      onCancel();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function startHolding() {
    startRef.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
  }

  function stopHolding() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setProgress(0); // let go early = reset, nothing happens
  }

  return (
    <div className="emergency-exit">
      <button
        type="button"
        className="emergency-button"
        // Mouse and touch both need to start/stop the hold.
        onMouseDown={startHolding}
        onMouseUp={stopHolding}
        onMouseLeave={stopHolding}
        onTouchStart={startHolding}
        onTouchEnd={stopHolding}
      >
        Emergency stop (hold 3s)
        <span
          className="emergency-fill"
          style={{ width: `${progress * 100}%` }}
        />
      </button>
      <p className="emergency-caption">
        For real emergencies only. Hold the button for 3 seconds to stop the
        alarm and end the workout without finishing your reps.
      </p>
    </div>
  );
}
