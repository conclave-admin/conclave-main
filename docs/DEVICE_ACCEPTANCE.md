# Physical-device messaging acceptance

Automation uses Chromium desktop and mobile emulation with real disposable
PostgreSQL/Redis and mocked storage. It cannot certify Android hardware, iOS,
real cloud storage, keyboards, push permissions, or OS background restrictions.
The user has Android available; physical iPhone acceptance remains open.

## Setup

Use a deployed/staging HTTPS frontend and API with real R2 and a verified preview
Worker. Two independent accounts and a second browser/device are needed. Use test
files and conversations only. Record Android version, browser version, build
commit, network, screen dimensions, and exact reproduction steps for a failure.
Do not expose recovery keys, access tokens, message content or signed media URLs
in shared screenshots/logs.

## Android checklist

- [ ] Inbox appears promptly; previews resolve independently, including offline cache.
- [ ] Type a draft and select a reply; switch chats, background, reload, and restore.
- [ ] Open/close keyboard, rotate, and change text size; composer/send controls stay visible.
- [ ] Paste long paragraphs, URLs, unbroken strings, and fenced code; expand/collapse without overflow or lost position.
- [ ] Search encrypted/local and readable history; follow results and return to reading position.
- [ ] Switch offline, send text/media, reconnect; pending status is honest and retries do not duplicate.
- [ ] Record, preview, discard, interrupt recording with an incoming call/backgrounding, and play cached voice offline.
- [ ] Download, cancel, retry, reopen and clear media cache; verify actual device/storage behavior.
- [ ] React with the picker, open thread pages, send a thread reply and inspect unread counts on another account.
- [ ] Save a message, open private notes, set/cancel a reminder, and verify foreground/background behavior.
- [ ] Schedule text, close the app, verify exactly one send; change recipients/devices and confirm review is required.
- [ ] Test timed mute, mention levels, DND, custom status and admin-only broadcast mentions.
- [ ] Set a disappearing-message timer; confirm the visible policy and test expiry using an isolated staging clock/fixture, never production clock changes.
- [ ] Delete chat for self and confirm peer history, group membership and pending sends remain correct.
- [ ] Use TalkBack and an external keyboard: dialog focus stays inside, names are announced, Escape/back and focus return work.
- [ ] Confirm comfortable targets, contrast, reduced motion and no horizontal overflow.

## Evidence

Record PASS/FAIL/NOT TESTED for each row with build ID, device details and a
sanitized screenshot/video where useful. iPhone/Safari, real provider push/media,
independent encryption security review and production load are separate release
requirements; do not mark them passed based on Android or emulator results.
