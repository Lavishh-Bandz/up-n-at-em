// HoldButton.jsx
// -----------------------------------------------------------------------------
// A small, reusable "press and HOLD" button with a filling progress bar.
//
// WHY THIS EXISTS: the app already has one hold-to-confirm interaction in
// EmergencyExit.jsx (hold ~3s to bail out of a workout). We want the SAME
// safe, hard-to-trigger-by-accident gesture for the DELIBERATE "Skip today"
// control on the settings screen. Rather than copy EmergencyExit's hold logic,
// we pull the reusable pieces into this one tiny component so both places share
// identical, well-tested behaviour:
//   - you must hold for `holdMs` milliseconds for it to fire,
//   - letting go early resets the bar and does nothing,
//   - a progress bar fills left-to-right so you can see the countdown.
//
// IMPORTANT: this does NOT change EmergencyExit.jsx. EmergencyExit keeps its
// own copy of the hold logic so its behaviour is provably unchanged by this
// feature. HoldButton is used by the new Skip-today control (and is available
// for future reuse).
//
// This is a presentational widget only. It reads the real clock (Date.now())
// to animate the bar, which is fine — it is UI, not progression logic, and it
// never records anything itself. What happens on a completed hold is entirely
// up to the `onHoldComplete` callback the caller passes in.

import { useRef, useState } from 'react';

/**
 * @param {object} props
 * @param {() => void} props.onHoldComplete  Fired once when the hold completes.
 * @param {number} [props.holdMs=2500]       How long (ms) the user must hold.
 * @param {string} [props.label]             The button text.
 * @param {string} [props.className]         Extra class for styling hooks.
 */
export default function HoldButton({
  onHoldComplete,
  holdMs = 2500,
  label = 'Hold to confirm',
  className = '',
}) {
  const [progress, setProgress] = useState(0); // 0..1 fill of the hold bar
  const rafRef = useRef(null);
  const startRef = useRef(0);

  // One animation-frame step: work out how far through the hold we are and,
  // once we reach the end, fire the callback exactly once.
  function tick() {
    const elapsed = Date.now() - startRef.current;
    const ratio = Math.min(1, elapsed / holdMs);
    setProgress(ratio);
    if (ratio >= 1) {
      stopHolding();
      onHoldComplete();
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

  const seconds = Math.ceil(holdMs / 1000);

  return (
    <button
      type="button"
      className={`hold-button ${className}`.trim()}
      // Mouse and touch both need to start/stop the hold.
      onMouseDown={startHolding}
      onMouseUp={stopHolding}
      onMouseLeave={stopHolding}
      onTouchStart={startHolding}
      onTouchEnd={stopHolding}
    >
      {/* The growing fill sits UNDER the label, just like EmergencyExit, so the
          text stays readable while the bar slides behind it. */}
      <span className="hold-fill" style={{ width: `${progress * 100}%` }} />
      <span className="hold-label">
        {label} (hold {seconds}s)
      </span>
    </button>
  );
}
