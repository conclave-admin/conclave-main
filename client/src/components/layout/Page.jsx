import { useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * The frame every page sits in.
 *
 * The outer element is the scroll container and runs the full width, so its
 * scrollbar lands at the window's edge instead of in the middle of the screen.
 * The page's content is what gets capped and centred inside it. That is the
 * difference between this and wrapping a page in `mx-auto max-w-*`: that centres
 * the whole box, scrollbar included, which pulls the scrollbar away from the
 * edge on wide screens and leaves an asymmetric gutter beside it.
 *
 * `width` only changes how wide the content gets, never whether it is centred,
 * and it is one of five tokens so two pages cannot end up on two different
 * scales by accident.
 *
 * @param {'form'|'content'|'board'} width - form fields, readable text, or a
 *   three-column board. Full-width (no cap) is not offered: an uncapped line of
 *   prose is unreadable and an uncapped form fields drift apart. Pages that need
 *   the whole viewport, like the chat shell, do not use Page at all.
 * @param {string} [className]
 * @param {React.ReactNode} children
 */
const WIDTHS = {
  form: "max-w-2xl",
  content: "max-w-4xl",
  board: "max-w-6xl",
};

export default function Page({ width = "content", className = "", children }) {
  const scrollRef = useRef(null);
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    // App pages scroll inside the shell rather than the browser window.
    scrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname]);

  return (
    <div
      ref={scrollRef}
      className="h-full min-h-0 overflow-y-auto overscroll-contain"
    >
      <div
        className={`mx-auto w-full min-w-0 px-4 py-6 md:px-7 md:py-8 ${WIDTHS[width]} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
