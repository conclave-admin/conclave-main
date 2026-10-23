# Voice messages (GH-06)

## Recording and sending

Record from the message composer, then stop to open the existing attachment
preview. The preview offers local audio playback, a caption, an explicit
**Discard voice message** action, and Send. No upload happens before Send.
Backgrounding, recorder failure, permission cancellation, and leaving the
conversation retain the existing microphone/recording-indicator cleanup rules.

The recorder prefers a supported audio container. Codec parameters are removed
from the File MIME type, while the actual container bytes are unchanged. WebM,
Ogg, and MP4 recordings use `.weba`, `.ogg`, and `.m4a` names respectively.
Unsupported formats fail with an actionable message rather than creating a file
whose extension disagrees with its content.

## Receiving and playback

Audio attachments now have an inline native audio player instead of a generic
file card. Controls include play/pause, seeking, duration, and a labelled speed
selector (1×, 1.25×, 1.5×, 2×). Starting another voice message pauses the previous
one; session end pauses playback. Save audio exports the local downloaded copy.
An unsupported decoder shows an error while retaining the save option.

The player downloads through the existing authorized media downloader. Local
sender files and cached recipient files are reused. The local Blob gets an
object URL that is revoked when replaced or unmounted. Some WebM recordings
omit a duration header; the player probes the end of the downloaded Blob to
recover duration and seeking without an additional server request.

Encrypted conversations use the existing ciphertext download and local decryption
path. No decrypted audio or audio preview is sent to a transformation Worker.
Playback remains available offline once the original is downloaded and cached;
undownloaded originals need connectivity. Cache eviction, browser site-data
removal, and account cache cleanup can remove offline availability. Existing
Documents auto-download preferences also cover audio; this work does not add a
separate audio auto-download setting.

## Verification

- `client/test/voiceRecording.test.js`: container selection, codec normalization,
  correct extension/bytes, unsupported-format handling.
- `client/e2e/security-encryption.spec.js`: actual fake-microphone browser recording,
  preview/discard without a server message, recorded audio sending/playback,
  encrypted and server-readable WAV downloading, speed/seeking, cached offline
  playback and reuse after reload, plus mobile width checks.
- `client/e2e/realtime-access.spec.js`: existing recording activity and cleanup
  regressions (backgrounding, navigation/late permissions, recorder failure).

The security browser fixture uses real API/PostgreSQL/Redis and mocked storage.
Desktop and mobile tests run in Chromium (mobile emulation); these checks do not
prove real microphone, Safari/iOS codec behavior, or live R2 delivery. Real-device
acceptance remains in Phase 7.
