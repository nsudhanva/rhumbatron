import type { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  path: string;
  readOnly?: boolean;
  /** Accessible name of the editing area. */
  label?: string;
  minHeight?: number;
  maxHeight?: number;
};

/**
 * Code editor (CodeMirror 6) in the file view's dress. CodeMirror loads on the
 * client only, in its own chunk; until it is ready, and during the server render, a plain mono
 * textarea with the same value stands in. The editor mounts once per path and read-only state;
 * a new `value` from outside replaces its document.
 */
export function CodeEditor({
  value,
  onChange,
  path,
  readOnly = false,
  label = `Contents of ${path}`,
  minHeight,
  maxHeight,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncRef = useRef<((view: EditorView, value: string) => void) | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;
  const focusOnReadyRef = useRef(false);
  const [ready, setReady] = useState(false);

  // The editor reads value and onChange through refs; it remounts only for a new file, mode,
  // label or size.
  useEffect(() => {
    let cancelled = false;
    let view: EditorView | null = null;
    // The server bundle leaves CodeMirror out: effects never run there.
    const setup = import.meta.env.SSR
      ? Promise.reject(new Error("CodeMirror loads in the browser only"))
      : import("./codemirror-setup");
    setup
      .then(async ({ createEditor, syncValue }) => {
        const parent = parentRef.current;
        if (cancelled || !parent) return;
        const created = await createEditor(parent, {
          value: valueRef.current,
          path,
          readOnly,
          label,
          minHeight,
          maxHeight,
          onChange: (next) => onChangeRef.current(next),
        });
        if (cancelled) {
          created.destroy();
          return;
        }
        // Text typed in the textarea while the language loaded is carried over.
        syncValue(created, valueRef.current);
        view = created;
        viewRef.current = view;
        syncRef.current = syncValue;
        // Someone typing in the textarea keeps the keyboard when the editor replaces it.
        focusOnReadyRef.current = document.activeElement === fallbackRef.current;
        setReady(true);
      })
      .catch((error: unknown) => {
        // The textarea stays in place, so editing still works without CodeMirror.
        console.error("Code editor failed to load", error);
      });
    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
      setReady(false);
    };
  }, [path, readOnly, label, minHeight, maxHeight]);

  useEffect(() => {
    if (ready && focusOnReadyRef.current) viewRef.current?.focus();
    focusOnReadyRef.current = false;
  }, [ready]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && syncRef.current) syncRef.current(view, value);
  }, [value]);

  return (
    <>
      <div ref={parentRef} hidden={!ready} />
      {!ready && (
        <textarea
          ref={fallbackRef}
          aria-label={label}
          className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[12px] leading-[1.7] whitespace-pre outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
          style={{ minHeight, maxHeight }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          readOnly={readOnly}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </>
  );
}
CodeEditor.displayName = "CodeEditor";
