# Messaging UI

Conclave uses a WhatsApp-inspired conversation layout while retaining its purple
identity, collaboration navigation, permission model and existing media pipeline.
This is an implementation of existing messaging features, not a new calling,
stories, sticker or moderation feature.

## Layout and conversation list

- Desktop and tablet retain a conversation list beside the active room; the list
  width adapts to the available viewport. Phones show one pane at a time.
- Conversation rows are full width, separated by hairlines, with compact previews,
  unread counts, pinned/muted indicators and persistent overflow controls.
- Search and All/Unread/Groups/Direct/Archived filters retain their URL behavior.
- Typing/recording and drafts take precedence over message previews. Own-message
  ticks use the existing server receipt summaries; incomplete historical receipt
  data remains Sent rather than inventing Delivered or Read status.
- The desktop rail expands on hover or keyboard focus, moving the content aside
  without covering the chat list. The pin control keeps it open. The hamburger
  is reserved for phones.

## Messages and composer

- Consecutive messages retain the existing author grouping and first-message
  avatar. Bubbles use soft incoming/outgoing surfaces, responsive widths and
  individual timestamps, edit state and real delivery/read details.
- Reactions remain attached below the message; reply, edit, pin, thread,
  forward, reminder and task/decision actions retain their handlers.
- The static conversation wallpaper is an original vector motif using Conclave
  colors; it adds no animated background or external asset request.
- The composer uses a rounded pill with attachment and emoji controls. An empty
  composer offers voice recording; text offers Send. Recording always keeps its
  stop control. Mention insertion remains in the attachment menu, alongside
  existing file, camera, poll, task and decision actions when permitted.
- Attachment staging keeps per-file captions, removal, compression, progress,
  cancellation and errors. Thumbnails and removal controls are larger, and the
  dialog identifies the number of selected files.

## Media, settings and appearance

- Captioned attachments use a cohesive message surface; album tiles preserve
  their individual message identity and ordering.
- Shared photos/videos use a compact square grid. Opening a tile uses the
  existing viewer with previous/next navigation and a jump to the source message.
  Documents/audio, pagination, retry, authenticated download and offline states
  remain available.
- Settings has keyboard-focusable section shortcuts for appearance,
  notifications, privacy/security, focus and media, with consistent surfaces.
- Light, Dark and System retain their existing persistence. The mobile header
  uses the existing theme-aware logo component. Reduced-motion handling remains
  in place and media hover transitions respect that preference.

## Verification

See [release evidence](RELEASE_EVIDENCE.md) for the actual command results and
remaining work. New messaging-layout browser regressions cover list density,
rail overlap, composer controls, mentions, per-message timestamps/receipts and
settings focus. They are included in the recovery configuration for future CI
runs. Full CI and provider/device acceptance remain paused or pending; fixture
screenshots do not establish live-provider behavior.

## Compact media follow-up — 23 November 2026

The screenshot review replaced the oversized per-message album cards with a
bounded collage: 360px desktop / 320px mobile, cropped edge-to-edge tiles, 3px
gutters, a three-photo layout, and four visible tiles with +N overflow. Each
photo retains its caption, timestamp, receipt and actions. Overflow opens the
complete viewer; source-message jumps expand collapsed entries. Viewing a photo
may acknowledge that message only in the focused, online foreground viewer;
other or nested dialogs continue to block reads.

Uploads use in-photo circular progress, cancellation and retry controls.
Successful download labels are removed from the compact timeline; detailed
cache/download state remains available in the viewer. Hidden pending items keep
their upload controls in that viewer. Queue persistence and upload protocols are
unchanged.

The attachment preview has a large contained image, previous/next controls,
thumbnail selection and removal, per-file captions, Add more files, and a
circular Send button. Adding files preserves the existing selection/captions
and the same validation and selection limits. Nothing uploads until Send saves
the selection to the existing outbox.

[Superdesign media canvas](https://superdesign.dev/teams/88efab27-b55e-4eff-996d-2b794080c967/projects/ae608552-66f6-4575-91cd-eb126353196f)
contains the approved direct-import design and existing Conclave logo. No paid
AI generation was used. It illustrates the direction; local application
screenshots and browser checks verify the actual implementation.


## Profiles, mentions and media viewer — 23 November 2026

Recorded mention IDs resolve to member profile links, including display names
with spaces. Unknown or ambiguous names remain text; code and URLs retain their
literal content. Room member rows and DM info link to the same profile page.
The profile endpoint requires a shared room, returns no email, and applies the
existing photo/about privacy and block rules. Deleted/unavailable profiles have
a common 404 response. Own profiles retain the existing edit and deletion flows.

Room info has a centered identity header and direct Message / Media and files
shortcuts. Profile editing no longer repeats a separate preview card. Redundant
chat-list and shared-media helper copy is removed; privacy, destructive-action,
error and accessibility descriptions remain.

The neutral dark media viewer has consistent icon controls, sender attribution,
caption area and a selected thumbnail strip. It loads at most nine neighboring
thumbnail components rather than downloading every original. Swipe, keyboard
navigation, pinch/double-click zoom, retry/cancel, offline caching, source jumps
and reduced-motion behavior remain. Search uses a magnifier without a plus sign;
chat navigation uses the existing message icon on desktop and mobile.

Visual review also covered adjacent settings and room member lists. Theme and
notification helper copy is shorter, member safety/admin actions wrap below
names on phones, and the duplicate desktop Chats heading is hidden. The shared
media grid uses square thumbnails with date/source overlays; detailed file
metadata remains available for documents and audio. Loading image previews fill
the viewer without waiting for the original, which avoids an isolated tiny
thumbnail during download. Profile photos use the same neutral fullscreen
viewing surface. Broader task/project flows retain their existing behavior.

## Voice notes, documents and quiet offline files — 23 November 2026

The selected recording interaction is hybrid: tap starts hands-free recording;
holding starts a quick recording; sliding left cancels and sliding up locks it.
Releasing an unlocked hold saves the voice note through the existing account
outbox. Locked recordings provide pause/resume, discard, direct send and Stop
for waveform preview before sending. Recording uses actual microphone samples
for the live waveform and preserves the existing permission, interruption,
conversation cleanup and file-size protections.

Audio playback keeps the existing single-player policy, speed controls and
local Blob playback. Short supported files receive a waveform derived from the
actual decoded audio with an accessible seek slider. Decoding is serialized
and limited to nearby visible players, and peak data is reused for the same
Blob. Decode work is limited to 5 MB / five-minute files; longer or unsupported audio retains a neutral seek
track. This avoids a fabricated waveform and unbounded decoded audio memory.

All supported original types default to automatic downloading; explicit device
preferences, network restrictions and Data Saver remain respected. Automatic
transfers run with at most two active network downloads and can continue after
leaving a message. They run while the application is open, not as an operating
system download service after the browser has closed. Automatic progress and
success labels are quiet; manual controls remain available. Original bytes are
cached by account and immutable asset, independently of signed URLs.

IndexedDB remains the offline store. Completed originals are excluded from the
old automatic 250 MB eviction budget; that budget applies only to disposable
previews and partial transfers. Browser quota, browser eviction and clearing
site data still apply. Settings shows account-scoped usage, a downloaded-file
list, per-file removal and account-scoped clearing. Pending outbox Blobs are not
removed by media-cache controls. Save to device offers a separate external copy.

Document cards show filename/type/size with a save action. PDFs and text files
can open from cached bytes; text is rendered as escaped text with a 256 KB
preview limit, PDFs use the browser viewer with an open-tab fallback. Other
formats keep the device save flow instead of promising unsupported previews.

### Reopening downloaded media

Opening an image or replaying audio reuses its loaded Blob immediately without entering a downloading state. IndexedDB supplies the original after navigation/reload; cache rechecks preserve the existing Blob identity so active playback is not reset. If persistence is unavailable, a mounted attachment keeps its usable in-memory copy. Explicit cache removal and session changes still invalidate media. Download progress bars and numeric download percentages are omitted from attachment cards and the viewer; cancellation and actionable failures remain available. Upload progress is unchanged.
