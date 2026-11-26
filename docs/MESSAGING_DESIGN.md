# Messaging interface redesign

## Direction

Conclave keeps its purple identity with cool neutral light surfaces and deep slate
dark surfaces. The app uses familiar messaging navigation and information hierarchy,
while retaining rooms, tasks, decisions, catch-up, and privacy controls.

## Application-wide foundations

- Shared typography: readable message/form line heights, stronger page headings,
  quieter metadata, and consistent spacing.
- Shared controls: rounded inputs and buttons, visible keyboard focus, disabled
  states, and restrained pressed feedback.
- Desktop shell: persistent navigation rail, wider inbox, conversation pane, and
  a dedicated empty-conversation welcome with working navigation actions.
- Mobile shell: inbox-to-conversation navigation; open conversations reclaim the
  bottom-tab area for the composer, with a back action in the header.
- Chat list: larger avatars, comfortable rows, purple selection marker, search,
  filters, activity previews, and accessible overflow actions.
- Conversation: subtle canvas texture, contrasting incoming/outgoing bubbles,
  consistent avatar alignment, and a separated, safe-area-aware composer.
- Authentication/recovery/invitation pages: a shared split layout on large screens
  and a focused single-column form on phones.
- Settings, profiles, room information, discovery, notifications, tasks, decisions,
  and catch-up inherit the shared Page, typography, card, and control system.
- Existing landing-page illustrations and editorial composition remain, using the
  updated neutral theme tokens. This work does not replace product imagery.

## Responsive and accessibility choices

The conversation grid has an explicit shrinkable column so content cannot widen
its mobile viewport. Message text retains arbitrary-word wrapping. Card content
wraps, forms remain bounded, and motion respects reduced-motion preferences.
Purple actions have explicit light foregrounds and a separate dark fill.

## Review evidence and limits

A production build and local fixture screenshots were used during implementation.
Desktop conversation, mobile conversation, settings, and dark mode were inspected.
Visual review found mobile grid clipping; the conversation grid was corrected.
No automated test suites were added or run for this design task. Fixture media
can show unavailable previews; these screenshots do not verify live storage or
messaging delivery. Full real-device and assistive-technology acceptance remains
necessary before release.
