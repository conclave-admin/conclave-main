// Keep the container/MIME pair aligned: MediaRecorder often returns a codec
// parameter, whereas uploads and File.type use the base media type.
const formats = {
  "audio/webm": "weba",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};
export function voiceRecordingFile(chunks, mime, timestamp = Date.now()) {
  const type = String(mime || "audio/webm")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const extension = formats[type];
  if (!extension)
    throw new Error(
      "This browser recorded an unsupported audio format. Try another browser.",
    );
  return new File(chunks, `voice-note-${timestamp}.${extension}`, { type });
}
export function voiceRecorderOptions(Recorder) {
  const mimeType = [
    "audio/webm;codecs=opus",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ].find((type) => Recorder.isTypeSupported?.(type));
  return mimeType ? { mimeType } : undefined;
}
