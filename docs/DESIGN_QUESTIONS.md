# Design questions — from frontend implementation

Everything below came up while building the frontend against the Penpot file. Grouped by type. Nothing here blocks implementation; each has been handled one way or another, and this records the decisions that were made without a designer.

---

## A. File integrity — worth fixing in Penpot

### A1. Room View sidebar instances have been manually resized

The Sidebar component's master width is **248px** (Desktop) and **220px** (Tablet). Workspace Shell uses those correctly.

But Room View's sidebar instances render at **240px** and **210px** — 8px and 10px narrower. They are still *linked* instances, not detached, so Penpot doesn't flag them. Someone resized them on the canvas and the override was never reset.

Worth resetting to the master so the screens agree. The code follows the master values.

### A2. Icon boards are empty placeholders

Every board on the Icons page is an empty 24×24 box with a label and a Lucide name beside it. That's a workable convention — the page is a spec, not artwork — but it isn't obvious, and it cost time before we worked it out.

The mapping turned out to be valuable: the frontend icon set was audited against it and **four of five checked icons were wrong**, including ones already live in the sidebar.

### A3. Placeholder copy left in the boards — Resolved

Four instances where component placeholder text was never replaced:

| Board | Shows | Should be |
|---|---|---|
| Decisions | Button label "Default" | "New decision" |
| Decisions | Search placeholder "Search rooms" | "Search decisions" |
| Catch-up Digest | "Today · 13:42 AM" | invalid 12-hour time; used "1:42 PM" |
| Catch-up Digest | "Today · 12:32 AM" | valid, but reads as midnight mid-morning |

Also: the Tasks Board repeats the same three task titles across all three columns, and Decisions uses the same `#product-eng` on every card despite the screen's whole point being cross-room. Both read as placeholder duplication rather than intent.

**Resolved:** all 11 placeholder text nodes corrected.

### A4. Naming case is inconsistent between boards and library assets

Board names use camelCase (`textPrimary`) while library assets use spaced
title case (`Text Primary`). Pre-existing inconsistency in the file —
worth picking one convention.

---

## B. Screens that don't exist

### B1. No Profile screen

The sidebar footer links to a profile, and there's no Profile board at any breakpoint. A functional placeholder was built (user info, logout, danger zone) with a comment marking it as temporary.

This mattered more than it sounds: logout was removed from the topbar to match the design, and with no Profile screen designed there was briefly nowhere to log out from.

### B2. No Direct messages screen

The sidebar Workspace section lists "Direct messages" and there's no DM board. The nav item points at `/dms`, which currently falls through to Home.

### B3. No Decisions or Tasks link in the sidebar

Both screens exist in the design; neither has a nav entry on the Sidebar board. Nav items were added as an addition, marked in code comments.

---

## C. Mobile can't reach several things

A consistent pattern rather than three separate oversights — worth one decision rather than three.

| Action | Mobile board |
|---|---|
| "Review updates" (opens the Catch-up Digest screen) | Button not present |
| "New decision" | Button not present |
| Catch-up Digest screen | No nav item, and the only route in is a hidden button |

Each was implemented as drawn (hidden below `md`). But the result is that a mobile user can't create a decision or reach the digest screen at all.

**Question: are the mobile boards intentionally read-only views, or is this an oversight repeated three times?**

---

## D. States the design doesn't cover

Nothing below appears on any board.

1. **Hover and disabled states** — no button states are drawn. Primary hover/disabled are currently derived as `brand/90` and `brand/40`.
2. **Focus states** — nothing drawn. Focus rings were kept; removing them would be an accessibility regression.
3. **Loading and error states** — no board shows either.
4. **`edited_at` / `deleted_at` on messages** — both are in the payload, neither is drawn.
5. **Date separators in the message timeline** — not drawn, almost certainly needed.
6. **Message grouping** — should consecutive messages from one sender collapse the avatar and name?
7. **Avatar with a real image** — the design shows flat grey circles. What happens when a user has an `avatar_url`? What's the fallback — flat grey, or initials?
8. **Connection status** — not in the design. It was kept, because a realtime app that silently stops indicating disconnection is worse than one that deviates from a mock.
9. **RoomHeader content** — the TopBar board only shows a generic "Workspace title" placeholder. Room name, member count and connection status aren't modelled at any breakpoint.
10. **Multiple attachments on one message** — the File Attachment variant shows exactly one card. Stacking was implemented as an interim.

---

## E. Measured values worth confirming

### E1. Line height is 1.2 everywhere

There is one line-height token, `Typography.LineHeight.Default = 1.2`, referenced by every typography token. On 14px body text that's 16.8px, which is tight for a scrolling message timeline.

Implemented as specified. Worth confirming it's intended rather than a default that was never revisited.

### E2. Fixed 94/98px timestamp column — Resolved

In every message row the timestamp sits at a fixed offset from the content column start, not as a gap after the author name — confirmed across rows with different name lengths. Implemented as a fixed-width column.

Is that deliberate alignment, or an artefact of hand-placing text?

**Resolved:** fixed 98px timestamp column at all breakpoints, confirmed
against the components. The 94px figure came from hand-drawn rows that
no longer exist. Implementation was correct.

### E3. Asymmetric TopBar padding

Left 16px, right 28px. Implemented as drawn.

### E4. Nav rows 44px, room rows 42px — Confirmed deliberate

A 2px difference between two visually parallel lists. Treated as measurement noise and both implemented at 44.

**Resolved:** confirmed deliberate, not noise. Nav rows 44px, room rows
42px. Code updated.

### E5. Row spacing in mockups is slot-based, not flow-based — Partially resolved

Message rows in the Room View and Workspace Shell boards sit at a constant 100px pitch regardless of their actual height — rows of 43px and 60px both produce a 100px delta. That only happens with fixed-height slots.

This matters because it makes the apparent gap unmeasurable from those boards. Mobile is the only board where spacing flows with content, at a consistent 16px, so that's the value used.

**Partially resolved:** Room View boards now use real 24px flow gaps
(Mobile 16px) and code is updated to `space-y-4 md:space-y-6`. The
Workspace Shell boards still have the slot artefact, so Home's activity
list stays at 16px.

---

## F. Layout questions

### F1. Three columns at tablet width is tight

The Tasks Board keeps three columns at 834px, giving roughly 183px per column. Real task titles wrap to three lines there. The board's own sample titles are short enough to hide this.

Would two columns with horizontal scroll serve better?

### F2. Tablet and Desktop genuinely differ

Worth recording, because it shaped the build. The Message component is byte-identical at Tablet and Desktop, which suggested one breakpoint would do. But three things differ:

- Sidebar: 220 vs 248
- Home overview cards: 2-up vs 3-up
- Catch-up digest card: 592 vs 1168 wide

So the design describes three layouts, not two, and the frontend now has `md` (768) for Tablet and `lg` (1280) for Desktop.

### F3. `brand-soft` isn't a token — Resolved

`#EEF2FF` is used by several components — the active sidebar row among them — but isn't in the Foundations token set. Worth adding as `Color.Primary.Soft`.

**Resolved:** `Color.Primary.Soft` (`#EEF2FF`) added to Foundations as
both a library asset and a swatch board.
