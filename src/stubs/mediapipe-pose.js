// mediapipe-pose.js (build stub)
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS:
//   @tensorflow-models/pose-detection can run several models. One of them,
//   BlazePose, is powered by Google's @mediapipe/pose package. That package
//   ships as a non-standard UMD bundle that modern bundlers (Vite/Rolldown)
//   cannot statically analyse, which breaks the production build with a
//   "'Pose' is not exported" error.
//
//   UP N AT EM only uses the MoveNet model (with the TensorFlow.js runtime),
//   which does NOT touch @mediapipe/pose at all. So we alias that package to
//   this harmless empty stub in vite.config.js. If BlazePose's mediapipe
//   runtime were ever requested at runtime it would throw a clear error, but we
//   never request it.
//
// Providing a named `Pose` export keeps the import that the library performs
// valid, so bundling succeeds.
export class Pose {}
export default { Pose };
