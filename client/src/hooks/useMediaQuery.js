import { useEffect, useState } from "react";

/**
 * Subscribe to a media query.
 *
 * A boolean read once in a component body would be wrong the moment the window
 * crosses the breakpoint, and the attach menu deliberately swaps a popover for a
 * sheet on resize — so the value has to be live, not a first-render snapshot.
 *
 * @param {string} query - a CSS media query, e.g. '(min-width: 768px)'
 * @returns {boolean} whether it currently matches
 */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
