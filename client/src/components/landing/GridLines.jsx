/**
 * The decorative hairline grid the landing sits on.
 *
 * Three separate column sets rather than one responsive set, because the
 * breakpoints cannot be expressed as classes on the same element: `md:block`
 * and `md:hidden` both win at `md`, and which one applies depends on stylesheet
 * order rather than on the class list. Splitting them makes the count per
 * breakpoint explicit and impossible to get wrong.
 *
 * Purely decorative, so it is hidden from the accessibility tree and ignores
 * pointer events — otherwise it would sit under the hero and eat clicks.
 */
const BASE = 4;
const MD = 8;
const LG = 12;

function Columns({ count }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="h-full flex-1 border-l border-line/40" />
      ))}
    </>
  );
}

export default function GridLines({ className = '' }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <div className="mx-auto flex h-full max-w-7xl px-6 md:px-10 lg:px-16">
        <div className="flex w-full md:hidden">
          <Columns count={BASE} />
        </div>
        <div className="hidden w-full md:flex lg:hidden">
          <Columns count={MD} />
        </div>
        <div className="hidden w-full lg:flex">
          <Columns count={LG} />
        </div>
      </div>
    </div>
  );
}
