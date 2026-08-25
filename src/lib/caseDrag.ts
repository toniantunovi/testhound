// Dragging a case row onto a suite, a folder, or another row.
//
// Deliberately not HTML5 drag and drop. The webview installs an OS-level
// drag-drop handler, which the assistant panel needs to receive real file paths
// (see AssistantPanel.tsx), and that handler consumes in-page drags before the
// page sees `dragover` or `drop`: a `draggable` row starts a drag that can never
// land. Pointer events are untouched by it and behave the same everywhere.
//
// Drop targets mark themselves with data attributes instead of handlers, so the
// drag resolves what is under the pointer with `elementFromPoint` and the tree
// and the table need no shared React state.
import { create } from "zustand";

/** Where a dragged case would land if the pointer were released now. */
export type CaseDropTarget =
  /** A suite or folder row in the tree: file the case there. */
  | { kind: "tree"; suite: string; section: string | null }
  /** A table row: land on the nearer edge of it. */
  | { kind: "row"; id: string; after: boolean }
  /** A group header: land at the end of that group. */
  | { kind: "group"; key: string };

interface CaseDragState {
  /** The cases being dragged, in display order. Empty when no drag is in
   *  flight; more than one when the drag started on a ticked row. */
  dragIds: string[];
  /** What the ghost under the cursor reads: a title, or "N cases". */
  label: string;
  target: CaseDropTarget | null;
}

/** Drag state every target subscribes to. Select a boolean from it, so a row
 *  re-renders only when its own highlight changes. */
export const useCaseDrag = create<CaseDragState>(() => ({
  dragIds: [],
  label: "",
  target: null,
}));

/** Pointer position, kept in its own store so the ghost can follow the cursor
 *  without waking every row's subscription on every move. */
export const useDragPointer = create<{ x: number; y: number }>(() => ({
  x: 0,
  y: 0,
}));

const SUITE_ATTR = "data-drop-suite";
const SECTION_ATTR = "data-drop-section";
const ROW_ATTR = "data-drop-row";
const GROUP_ATTR = "data-drop-group";

/** Spread onto a tree row to file a dropped case into `suite`/`section`. */
export const treeTarget = (suite: string, section: string | null) => ({
  [SUITE_ATTR]: suite,
  ...(section === null ? {} : { [SECTION_ATTR]: section }),
});

/** Spread onto a table row: a drop lands on whichever edge is nearer. */
export const rowTarget = (id: string) => ({ [ROW_ATTR]: id });

/** Spread onto a group header: a drop lands at the end of that group. */
export const groupTarget = (key: string) => ({ [GROUP_ATTR]: key });

/** How far the pointer must travel before a press becomes a drag, so a plain
 *  click still selects the row and a double-click still opens it. */
const SLOP = 4;

/** How close to a scroll container's edge the pointer must come before the
 *  container scrolls under it, and how far it then scrolls per frame. */
const SCROLL_EDGE = 48;
const SCROLL_STEP = 10;

function targetFrom(el: Element | null, y: number): CaseDropTarget | null {
  if (!el) return null;
  const tree = el.closest(`[${SUITE_ATTR}]`);
  if (tree)
    return {
      kind: "tree",
      suite: tree.getAttribute(SUITE_ATTR)!,
      section: tree.getAttribute(SECTION_ATTR),
    };
  const row = el.closest(`[${ROW_ATTR}]`);
  if (row) {
    const box = row.getBoundingClientRect();
    return {
      kind: "row",
      id: row.getAttribute(ROW_ATTR)!,
      after: y > box.top + box.height / 2,
    };
  }
  const group = el.closest(`[${GROUP_ATTR}]`);
  if (group) return { kind: "group", key: group.getAttribute(GROUP_ATTR)! };
  return null;
}

/** The nearest ancestor that can actually scroll vertically, for auto-scroll. */
function scrollableFrom(el: Element | null): HTMLElement | null {
  let node = el as HTMLElement | null;
  while (node) {
    if (node.scrollHeight > node.clientHeight) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === "auto" || overflow === "scroll") return node;
    }
    node = node.parentElement;
  }
  return null;
}

const sameTarget = (a: CaseDropTarget | null, b: CaseDropTarget | null) => {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "tree" && b.kind === "tree")
    return a.suite === b.suite && a.section === b.section;
  if (a.kind === "row" && b.kind === "row")
    return a.id === b.id && a.after === b.after;
  if (a.kind === "group" && b.kind === "group") return a.key === b.key;
  return false;
};

/** Publish the target only when it really changed: the pointer crosses a row
 *  edge far less often than it moves, and every target re-renders on a change. */
function setTarget(next: CaseDropTarget | null) {
  if (sameTarget(useCaseDrag.getState().target, next)) return;
  useCaseDrag.setState({ target: next });
}

const swallowClick = (e: MouseEvent) => {
  e.stopPropagation();
  e.preventDefault();
};

/** Begin a drag from a pointerdown on a case row. `onDrop` receives the target
 *  under the pointer when it is released; a release over nothing does nothing. */
export function startCaseDrag(
  e: React.PointerEvent,
  caseIds: string[],
  label: string,
  onDrop: (target: CaseDropTarget, caseIds: string[]) => void,
) {
  // Checkboxes, badges and row menus own their own presses.
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button, input, a, select, textarea"))
    return;

  const source = e.currentTarget as HTMLElement;
  const pointerId = e.pointerId;
  const from = { x: e.clientX, y: e.clientY };
  let at = from;
  let dragging = false;
  let scroller: HTMLElement | null = null;
  let frame = 0;

  /** Re-resolve the target from the pointer's current position. A dragged row is
   *  never its own target, so it shows no insertion marker. */
  const aim = () => {
    const el = document.elementFromPoint(at.x, at.y);
    scroller = scrollableFrom(el);
    const target = targetFrom(el, at.y);
    setTarget(
      target?.kind === "row" && caseIds.includes(target.id) ? null : target,
    );
  };

  const step = () => {
    frame = requestAnimationFrame(step);
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    if (at.y < box.top + SCROLL_EDGE) scroller.scrollTop -= SCROLL_STEP;
    else if (at.y > box.bottom - SCROLL_EDGE) scroller.scrollTop += SCROLL_STEP;
    else return;
    // The rows moved under a pointer that may be standing still.
    aim();
  };

  const move = (ev: PointerEvent) => {
    at = { x: ev.clientX, y: ev.clientY };
    if (!dragging) {
      if (Math.abs(at.x - from.x) < SLOP && Math.abs(at.y - from.y) < SLOP)
        return;
      dragging = true;
      // Captured only once the press is really a drag, so an ordinary click is
      // left alone. Capture keeps the moves and the release coming even if the
      // pointer leaves the window, so a drag can never be left hanging.
      source.setPointerCapture(pointerId);
      useCaseDrag.setState({ dragIds: caseIds, label });
      frame = requestAnimationFrame(step);
    }
    useDragPointer.setState(at);
    aim();
  };

  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    cancelAnimationFrame(frame);
    if (!dragging) return;
    if (source.hasPointerCapture(pointerId))
      source.releasePointerCapture(pointerId);
    const target = useCaseDrag.getState().target;
    useCaseDrag.setState({ dragIds: [], target: null });
    // A press that moved is not a click: swallow the one the browser sends after
    // this pointerup, so a drag never also selects a row or a tree node. If none
    // arrives (the pointer came up over a different element), drop the listener
    // rather than let it eat the next real click.
    window.addEventListener("click", swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
    if (drop && target) onDrop(target, caseIds);
  };

  const up = () => finish(true);
  const cancel = () => finish(false);

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}
