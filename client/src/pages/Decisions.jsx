import { useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import Button from "../components/ui/Button";
import EmptyState from "../components/ui/EmptyState";
import { isDevAuthBypass, previewDecisions } from "../config/devPreview";

function DecisionCard({ decision }) {
  const date = new Date(decision.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return (
    <article className="rounded-xl border border-line bg-surface px-5 pt-18 pb-[21px]">
      <p className="text-label text-success">DECISION</p>
      {/* 14px/22px gaps measured on the Decisions boards — not on the Foundations
          spacing scale, kept as the measured arbitrary values. Combined with
          pt-18/pb-[21px] they reproduce the board's 130px card height for a
          one-line title, without hardcoding the height itself. */}
      <p className="mt-[14px] text-h2 text-ink">{decision.title}</p>
      <p className="mt-[22px] text-metadata text-muted">
        {decision.author_name} · {date} · #
        {decision.room_slug ?? decision.room_name}
      </p>
    </article>
  );
}

export default function Decisions() {
  const { setRoomHeader } = useOutletContext();
  useEffect(() => {
    setRoomHeader("Decisions");
    return () => setRoomHeader(null);
  }, [setRoomHeader]);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface px-4 pt-6 md:pt-9">
      <div className="flex items-start justify-between gap-4">
        <label className="block w-[300px]">
          <span className="mb-2 block text-label text-ink">Search</span>
          <input
            type="text"
            placeholder="Search decisions"
            className="h-12 w-full rounded-lg border border-line bg-surface px-3.5 text-body text-ink outline-none placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/15"
          />
        </label>
        {/* Absent from the Mobile board entirely (not just resized) — hidden below md.
            md:mt-6 aligns the button with the search input box itself: the "Search"
            label above the input has no counterpart next to the button, so the
            button needs the same 24px push to line up with the input's top edge. */}
        <Button
          variant="primary"
          className="hidden h-[42px] w-[160px] md:mt-6 md:inline-flex"
        >
          New decision
        </Button>
      </div>

      {isDevAuthBypass ? (
        <div className="mt-10 flex flex-col gap-5">
          {previewDecisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </div>
      ) : (
        <div className="mt-10 rounded-xl border border-dashed border-line">
          <EmptyState
            title="No decisions yet"
            description="Decisions promoted from room messages will appear here."
          />
        </div>
      )}
    </div>
  );
}
