/**
 * Server-rendered pages paint before their JavaScript runs, so a visitor can type into a field or
 * press a submit button before React hydrates it. Two things keep that safe:
 *
 * - {@link PRE_HYDRATION_SCRIPT} runs in <head>. For every text field React does not own yet, it
 *   records the latest value the visitor typed. For every form React does not own yet, it cancels
 *   native submission (a form with no action would reload the page and lose the text).
 * - {@link replayPreHydrationInput} runs after the root hydrates. Once React owns a recorded field
 *   (fields inside Suspense boundaries can hydrate in a later commit), it writes the value back
 *   through React's change path, so controlled state adopts the typed text instead of resetting it.
 *
 * "Owned by React" means the element carries React's `__reactProps$` key, which React sets when it
 * hydrates or creates an element.
 */

declare global {
  interface Window {
    /** Text typed into fields that React does not own yet, by field element. */
    __rhTyped?: Map<HTMLInputElement | HTMLTextAreaElement, string>;
    /** Set by {@link replayPreHydrationInput}; the head script calls it after it records a value. */
    __rhReplay?: () => void;
  }
}

/** Keep dependency-free; it runs before any bundle loads. */
export const PRE_HYDRATION_SCRIPT = `(function(){var w=window,t=w.__rhTyped=new Map();function o(x){for(var k in x)if(k.indexOf("__reactProps$")===0)return true;return false}document.addEventListener("input",function(e){var x=e.target;if(x&&!o(x)&&(x.tagName==="TEXTAREA"||(x.tagName==="INPUT"&&/^(text|search|email|url|tel|number|password)$/.test(x.type)))){t.set(x,x.value);if(w.__rhReplay)w.__rhReplay()}},true);document.addEventListener("submit",function(e){if(!o(e.target))e.preventDefault()},true)})();`;

function nativeValueSetter(element: HTMLInputElement | HTMLTextAreaElement) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, "value")?.set;
}

function ownedByReact(element: Element): boolean {
  return Object.keys(element).some((key) => key.startsWith("__reactProps$"));
}

function writeThroughReact(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setNative = nativeValueSetter(element);
  if (!setNative) return;
  // React compares the DOM value with the last value it saw. Assigning through the element
  // resets that record to "", then the native setter writes the text without updating it, so
  // the input event below reaches the field's onChange.
  element.value = "";
  setNative.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Frames to wait for React to own a recorded field (about 5 s) before giving up on it. */
const MAX_FRAMES = 300;

/** Call once, after the root has hydrated. */
export function replayPreHydrationInput(): void {
  const typed = window.__rhTyped;
  if (!typed) return;
  let frames = 0;
  let running = false;
  // A hydrating render can yield before it commits, so a field counts as hydrated once React has
  // owned it for a full frame.
  const owned = new Set<Element>();
  const step = () => {
    for (const [element, value] of typed) {
      if (!element.isConnected) typed.delete(element);
      else if (owned.has(element)) {
        typed.delete(element);
        writeThroughReact(element, value);
      } else if (ownedByReact(element)) owned.add(element);
    }
    running = typed.size > 0 && ++frames < MAX_FRAMES;
    if (running) requestAnimationFrame(step);
  };
  window.__rhReplay = () => {
    frames = 0;
    if (!running) {
      running = true;
      requestAnimationFrame(step);
    }
  };
  window.__rhReplay();
}
