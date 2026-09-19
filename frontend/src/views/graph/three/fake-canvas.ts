// Test-only fake canvas for the 3D label path (plan 47 Task 4b). This repo's
// jsdom has no canvas backend — getContext('2d') returns null — so the label
// sprite would take its null branch in every test and pass vacuously. This
// factory returns a canvas whose 2D context RECORDS the calls makeLabelSprite
// makes, and whose measureText reports a fixed width. NOT a .test file: it is
// imported by both Landscape.test.ts and Landscape.fallback.test.tsx.
import type { CanvasFactory } from './Landscape';

/** The 2D-context state a real canvas resize resets. Mirrored field for field
 * so the double fails for the same reasons a browser would (finding fc73e2a4). */
interface ContextState {
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  textBaseline: string;
}

const RESET_STATE: ContextState = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textBaseline: 'alphabetic' };

export interface CanvasRecorder {
  fonts: string[];
  fillStyles: string[];
  strokeStyles: string[];
  lineWidths: number[];
  /** Assignments made AFTER canvas.width/height were set (the reset boundary),
   * per property — only these survive into the drawn label. */
  afterResize: { font: string[]; fillStyle: string[]; strokeStyle: string[]; lineWidth: number[] };
  fillTexts: Array<[string, number, number]>;
  strokeTexts: Array<[string, number, number]>;
  created: number;
}

export function fakeCanvasFactory(measuredWidth = 100): { factory: CanvasFactory; recorder: CanvasRecorder } {
  const recorder: CanvasRecorder = {
    fonts: [], fillStyles: [], strokeStyles: [], lineWidths: [],
    afterResize: { font: [], fillStyle: [], strokeStyle: [], lineWidth: [] },
    fillTexts: [], strokeTexts: [], created: 0,
  };
  const factory: CanvasFactory = () => {
    recorder.created += 1;
    const canvas = document.createElement('canvas');
    let resized = false;
    const state: ContextState = { ...RESET_STATE };
    const ctx = {
      get font() { return state.font; },
      set font(value: string) { state.font = value; recorder.fonts.push(value); if (resized) recorder.afterResize.font.push(value); },
      get fillStyle() { return state.fillStyle; },
      set fillStyle(value: string) { state.fillStyle = value; recorder.fillStyles.push(value); if (resized) recorder.afterResize.fillStyle.push(value); },
      get strokeStyle() { return state.strokeStyle; },
      set strokeStyle(value: string) { state.strokeStyle = value; recorder.strokeStyles.push(value); if (resized) recorder.afterResize.strokeStyle.push(value); },
      get lineWidth() { return state.lineWidth; },
      set lineWidth(value: number) { state.lineWidth = value; recorder.lineWidths.push(value); if (resized) recorder.afterResize.lineWidth.push(value); },
      get textBaseline() { return state.textBaseline; },
      set textBaseline(value: string) { state.textBaseline = value; },
      measureText: (_text: string) => ({ width: measuredWidth }),
      fillText: (text: string, x: number, y: number) => { recorder.fillTexts.push([text, x, y]); },
      strokeText: (text: string, x: number, y: number) => { recorder.strokeTexts.push([text, x, y]); },
    };
    // Mirror the real reset: assigning width or height resets EVERY field of
    // the 2D context's drawing state (font, fillStyle, strokeStyle, lineWidth,
    // textBaseline), not just the font.
    const reset = (): void => { resized = true; Object.assign(state, RESET_STATE); };
    Object.defineProperty(canvas, 'width', { get: () => 0, set: reset, configurable: true });
    Object.defineProperty(canvas, 'height', { get: () => 0, set: reset, configurable: true });
    // The fake context is structurally what makeLabelSprite reads; jsdom's own
    // getContext would return null here, which is the whole reason for the seam.
    // Installed as an own property so no assertion is needed to satisfy the
    // DOM overload set (the frontend is cast-free, Iron rule 7).
    Object.defineProperty(canvas, 'getContext', {
      value: (contextId: string) => (contextId === '2d' ? ctx : null), configurable: true,
    });
    return canvas;
  };
  return { factory, recorder };
}
