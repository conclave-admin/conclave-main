# CLAUDE.md

# Conclave

## Working agreement
- Show me the diff and wait for approval before writing to any file.
- One file at a time. Never batch edits.
- If a value is uncertain, stop and ask rather than choosing.

## Design source of truth
- Read design values from the connected Penpot file (Conclave-Foundations
  token set). There is no local spec file.
- Tailwind tokens in client/tailwind.config.js mirror Foundations. Use
  them; never hardcode hex values or arbitrary px.
- Line heights are unitless 1.2 everywhere.
- md (768px) and lg (1280px) are the only breakpoints. sm is removed
  deliberately. md covers the Penpot Tablet board (834), lg covers
  Desktop (1440).
- Values measured from the Desktop board belong at lg:; values
  measured from the Tablet board belong at md:.
- Not everything has a Penpot source: RoomHeader's dynamic text
  (room name/member count/connection status), Room's error states,
  and MessageTimeline's bottom padding aren't modeled on any board.
  Don't force a breakpoint value for these from a board that doesn't
  represent them.

## Do not touch
- Backend/API contracts and service-layer signatures.


## Icons

All icons live in client/src/assets/icons/ as individual SVGs.
Always check that folder before creating any icon. Never write inline
SVG markup or add an icon library.

Import via vite-plugin-svgr:
  import IconMenu from '@/assets/icons/menu.svg?react';
  <IconMenu className="h-6 w-6 text-ink" />

All icons use stroke="currentColor" and stroke-width 1.75, so colour
comes from the parent's text colour. Never hardcode a fill or stroke.

If an icon genuinely doesn't exist in that folder, stop and ask —
don't invent one.
