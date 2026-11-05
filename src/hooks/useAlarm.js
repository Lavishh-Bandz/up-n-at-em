// useAlarm.js
// -----------------------------------------------------------------------------
// The alarm sound. This is the whole point of UP N AT EM: a LOOPING tone that
// keeps going until you finish your workout.
//
// WHY WEB AUDIO INSTEAD OF AN MP3?
//   We generate the tone in code with the Web Audio API. That means no large
//   audio file to download and no licensing worries. The tone is a simple
//   beeping pattern that loops forever until stop() is called.
//
// IMPORTANT DESIGN RULE (safety + honesty):
//   This hook exposes start() and stop(), but the UI NEVER wires stop() to a
//   plain "mute" button. stop() is only called by the app in two places:
//     1. when the workout queue reports the whole workout is complete, or
//     2. by the explicit hold-to-cancel EMERGENCY escape.
//   So there is no ordinary way to silence the alarm without either doing the
//   reps or deliberately using the clearly-labelled emergency exit.
//
// AUTOPLAY POLICY:
//   Browsers block audio that starts without a user gesture. We therefore only
//   call start() from the click that begins the session, and we resume() the
//   AudioContext at that moment, which satisfies the policy.

import { useCallback, useEffect, useRef, useState } from 'react';

export function useAlarm() {
  const [playing, setPlaying] = useState(false);

  // Web Audio objects live in refs so they survive re-renders.
  const ctxRef = useRef(null);       // the AudioContext
  const oscRef = useRef(null);       // the oscillator producing the tone
  const gainRef = useRef(null);      // gain node, used to beep on/off
  const beepTimerRef = useRef(null); // setInterval id for the beep pattern

  // Build the audio graph once, lazily (first time start() is called).
  const ensureGraph = useCallback(() => {
    if (ctxRef.current) return;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';          // a harsh, attention-grabbing alarm timbre
    osc.frequency.value = 880;    // A5, a bright, piercing pitch
    gain.gain.value = 0;          // start silent; the beep pattern opens it

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    ctxRef.current = ctx;
    oscRef.current = osc;
    gainRef.current = gain;
  }, []);

  /**
   * Start the looping alarm. MUST be called from a user gesture (e.g. the
   * "Start" button click) so the browser allows audio.
   */
  const start = useCallback(() => {
    ensureGraph();
    const ctx = ctxRef.current;
    const gain = gainRef.current;
    if (!ctx || !gain) return;

    // Resume in case the context started in a suspended state (autoplay policy).
    if (ctx.state === 'suspended') ctx.resume();

    // Beep pattern: toggle the volume on/off twice a second so it pulses like
    // a real alarm rather than a flat continuous tone.
    if (beepTimerRef.current == null) {
      let on = false;
      beepTimerRef.current = window.setInterval(() => {
        on = !on;
        // setTargetAtTime gives a quick, click-free ramp.
        gain.gain.setTargetAtTime(on ? 0.2 : 0, ctx.currentTime, 0.01);
      }, 300);
    }

    setPlaying(true);
  }, [ensureGraph]);

  /**
   * Stop the alarm. Only the app calls this: on workout completion or via the
   * emergency escape. There is deliberately no manual mute button bound to it.
   *
   * As well as going silent, we actually SUSPEND the AudioContext so the audio
   * graph stops running and releases the audio hardware promptly, instead of
   * leaving a silent oscillator ticking away until the component unmounts. The
   * context is resumed again by the next start(), so the caller's view of
   * start()/stop()/playing is unchanged.
   */
  const stop = useCallback(() => {
    if (beepTimerRef.current != null) {
      window.clearInterval(beepTimerRef.current);
      beepTimerRef.current = null;
    }
    const gain = gainRef.current;
    const ctx = ctxRef.current;
    if (gain && ctx) {
      // Snap the volume to zero immediately so nothing is heard while the
      // context winds down.
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime);
    }
    // Suspend the context: this pauses the audio clock and lets the browser
    // release the audio hardware. suspend() returns a promise; we don't need to
    // await it, and we guard with a catch so a late/duplicate call can't throw.
    if (ctx && ctx.state === 'running') {
      Promise.resolve(ctx.suspend()).catch(() => {
        // Context already suspended or closed; nothing to do.
      });
    }
    setPlaying(false);
  }, []);

  // Safety net: if the component using the alarm unmounts, tear the audio
  // graph down completely so no tone is left running.
  useEffect(() => {
    return () => {
      if (beepTimerRef.current != null) {
        window.clearInterval(beepTimerRef.current);
        beepTimerRef.current = null;
      }
      if (oscRef.current) {
        try {
          oscRef.current.stop();
        } catch {
          // Already stopped; ignore.
        }
        oscRef.current = null;
      }
      if (ctxRef.current) {
        ctxRef.current.close();
        ctxRef.current = null;
      }
      gainRef.current = null;
    };
  }, []);

  return { start, stop, playing };
}

export default useAlarm;
