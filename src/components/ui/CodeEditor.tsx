import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { cn } from "@/lib/utils";

// CodeMirror styles itself via JS, so the design tokens from
// tailwind.config.js are repeated here as literals.
const theme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#0B0D10",
      color: "#E6EAF0",
      fontSize: "12.5px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily:
        "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
      lineHeight: "1.6",
    },
    // The app shell disables text selection globally; editor text is editable.
    ".cm-content": {
      caretColor: "#E6EAF0",
      userSelect: "text",
      WebkitUserSelect: "text",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#E6EAF0" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
      {
        backgroundColor: "rgba(110, 139, 255, 0.35)",
      },
    ".cm-gutters": {
      backgroundColor: "#0B0D10",
      color: "#5E6875",
      border: "none",
      borderRight: "1px solid #262B33",
    },
    ".cm-activeLine": { backgroundColor: "rgba(110, 139, 255, 0.07)" },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "#9AA4B2",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(0, 211, 167, 0.15)",
      outline: "1px solid rgba(0, 211, 167, 0.4)",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(210, 153, 34, 0.3)",
      outline: "1px solid rgba(210, 153, 34, 0.5)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(210, 153, 34, 0.5)",
    },
    ".cm-panels": {
      backgroundColor: "#14171C",
      color: "#E6EAF0",
      border: "none",
    },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #262B33" },
    ".cm-panel input, .cm-panel button": {
      backgroundColor: "#1B1F26",
      color: "#E6EAF0",
      border: "1px solid #333A44",
      borderRadius: "6px",
    },
    ".cm-tooltip": {
      backgroundColor: "#1B1F26",
      color: "#E6EAF0",
      border: "1px solid #333A44",
      borderRadius: "6px",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "#262B33",
      color: "#E6EAF0",
    },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.comment, t.meta], color: "#5E6875", fontStyle: "italic" },
  {
    tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword],
    color: "#A371F7",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#00D3A7" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#D29922" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#6E8BFF" },
  { tag: [t.typeName, t.className, t.namespace], color: "#E3A008" },
  { tag: t.definition(t.variableName), color: "#E6EAF0" },
  { tag: t.propertyName, color: "#9AA4B2" },
  { tag: [t.operator, t.punctuation], color: "#9AA4B2" },
  { tag: t.invalid, color: "#F85149" },
]);

/** Dark-themed CodeMirror 6 editor for TypeScript/JavaScript sources. The
 *  parent element sets the height; the editor scrolls within it. */
export function CodeEditor({
  value,
  onChange,
  onSave,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Invoked on Mod-S while the editor has focus. */
  onSave?: () => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!containerRef.current) return;
    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Mod-s before basicSetup so it wins over any default binding.
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            indentWithTab,
          ]),
          basicSetup,
          javascript({ typescript: true }),
          theme,
          syntaxHighlighting(highlight),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; `value` afterwards flows through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Adopt external value changes (e.g. a reload) without recreating the view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={containerRef} className={cn("h-full min-h-0", className)} />;
}
