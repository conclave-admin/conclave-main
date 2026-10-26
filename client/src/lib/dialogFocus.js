// The last open dialog owns focus; nested dialogs restore the previous layer.
const layers = [];
const baseline = new Map();
function isolate() {
  if (!layers.length) {
    for (const [element, inert] of baseline) element.inert = inert;
    baseline.clear();
    return;
  }
  const active = layers.at(-1).parentElement;
  for (const element of document.body.children) {
    if (!baseline.has(element)) baseline.set(element, element.inert);
    element.inert = element !== active;
  }
}
export function containDialog(panel) {
  if (!panel) return () => {};
  layers.push(panel);
  isolate();
  const focusable = () =>
    [
      ...panel.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
      ),
    ].filter((el) => el.getClientRects().length && !el.closest("[inert]"));
  const key = (e) => {
    if (layers.at(-1) !== panel || e.key !== "Tab") return;
    const items = focusable(),
      first = items[0],
      last = items.at(-1);
    if (!first) {
      e.preventDefault();
      panel.focus();
      return;
    }
    if (
      e.shiftKey &&
      (document.activeElement === first ||
        !items.includes(document.activeElement))
    ) {
      e.preventDefault();
      last.focus();
    } else if (
      !e.shiftKey &&
      (document.activeElement === last ||
        !items.includes(document.activeElement))
    ) {
      e.preventDefault();
      first.focus();
    }
  };
  const focus = (e) => {
    if (layers.at(-1) === panel && !panel.contains(e.target))
      (focusable()[0] || panel).focus();
  };
  document.addEventListener("keydown", key, true);
  document.addEventListener("focusin", focus);
  return () => {
    const at = layers.indexOf(panel);
    if (at >= 0) layers.splice(at, 1);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("focusin", focus);
    isolate();
  };
}

export const isTopDialog = (panel) => layers.at(-1) === panel;
