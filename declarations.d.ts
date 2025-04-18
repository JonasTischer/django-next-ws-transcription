// declarations.d.ts
// This file is used to declare global types or augment existing ones.

// Add webkitAudioContext to the Window interface for older Safari compatibility
interface Window {
  webkitAudioContext?: typeof AudioContext;
}