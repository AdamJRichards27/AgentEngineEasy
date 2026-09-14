import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAudioContainer,
  validateVoiceAudioUpload,
  assertPlausibleAudioDuration,
  assertProviderReportedDurationWithinLimit,
  configuredMaxVoiceAudioBytes,
  configuredMaxVoiceAudioDurationSeconds,
  VoiceUploadValidationError,
} from "../audioValidation.js";

function webmBytes(paddingLength = 20): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(paddingLength, 0x00)]);
}

function oggBytes(paddingLength = 20): Buffer {
  return Buffer.concat([Buffer.from("OggS", "ascii"), Buffer.alloc(paddingLength, 0x00)]);
}

function wavBytes(paddingLength = 20): Buffer {
  const riff = Buffer.from("RIFF", "ascii");
  const size = Buffer.alloc(4);
  const wave = Buffer.from("WAVE", "ascii");
  return Buffer.concat([riff, size, wave, Buffer.alloc(paddingLength, 0x00)]);
}

function mp4Bytes(paddingLength = 20): Buffer {
  const sizeBytes = Buffer.from([0x00, 0x00, 0x00, 0x18]);
  const ftyp = Buffer.from("ftyp", "ascii");
  const brand = Buffer.from("M4A ", "ascii");
  return Buffer.concat([sizeBytes, ftyp, brand, Buffer.alloc(paddingLength, 0x00)]);
}

function mp3Id3Bytes(paddingLength = 20): Buffer {
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33]), Buffer.alloc(paddingLength, 0x00)]);
}

function mp3RawFrameBytes(paddingLength = 20): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(paddingLength, 0x00)]);
}

test("configuredMaxVoiceAudioBytes and configuredMaxVoiceAudioDurationSeconds report the documented 5MB / 60s limits", () => {
  assert.equal(configuredMaxVoiceAudioBytes(), 5 * 1024 * 1024);
  assert.equal(configuredMaxVoiceAudioDurationSeconds(), 60);
});

test("detectAudioContainer recognises every supported container by its signature bytes", () => {
  assert.equal(detectAudioContainer(webmBytes()), "audio/webm");
  assert.equal(detectAudioContainer(oggBytes()), "audio/ogg");
  assert.equal(detectAudioContainer(wavBytes()), "audio/wav");
  assert.equal(detectAudioContainer(mp4Bytes()), "audio/mp4");
  assert.equal(detectAudioContainer(mp3Id3Bytes()), "audio/mpeg");
  assert.equal(detectAudioContainer(mp3RawFrameBytes()), "audio/mpeg");
});

test("detectAudioContainer returns null for bytes that match no known signature", () => {
  assert.equal(detectAudioContainer(Buffer.from("not-a-real-audio-file")), null);
  assert.equal(detectAudioContainer(Buffer.alloc(0)), null);
});

test("validateVoiceAudioUpload accepts each supported container when the declared type matches its detected bytes", () => {
  assert.deepEqual(validateVoiceAudioUpload(webmBytes(), "audio/webm"), {
    detectedMimeType: "audio/webm",
    byteLength: webmBytes().length,
  });
  assert.deepEqual(validateVoiceAudioUpload(oggBytes(), "audio/ogg"), {
    detectedMimeType: "audio/ogg",
    byteLength: oggBytes().length,
  });
  assert.deepEqual(validateVoiceAudioUpload(wavBytes(), "audio/wav"), {
    detectedMimeType: "audio/wav",
    byteLength: wavBytes().length,
  });
  assert.deepEqual(validateVoiceAudioUpload(mp4Bytes(), "audio/mp4"), {
    detectedMimeType: "audio/mp4",
    byteLength: mp4Bytes().length,
  });
  assert.deepEqual(validateVoiceAudioUpload(mp3Id3Bytes(), "audio/mpeg"), {
    detectedMimeType: "audio/mpeg",
    byteLength: mp3Id3Bytes().length,
  });
});

test("validateVoiceAudioUpload accepts real-world declared-type aliases for WAV and MP3", () => {
  assert.equal(validateVoiceAudioUpload(wavBytes(), "audio/wave").detectedMimeType, "audio/wav");
  assert.equal(validateVoiceAudioUpload(wavBytes(), "audio/x-wav").detectedMimeType, "audio/wav");
  assert.equal(validateVoiceAudioUpload(mp3Id3Bytes(), "audio/mp3").detectedMimeType, "audio/mpeg");
});

test("validateVoiceAudioUpload also tolerates a declared Content-Type with a charset/codec parameter", () => {
  assert.equal(validateVoiceAudioUpload(webmBytes(), 'audio/webm;codecs="opus"').detectedMimeType, "audio/webm");
});

test("validateVoiceAudioUpload rejects an empty upload with EMPTY_AUDIO, before any type check", () => {
  assert.throws(
    () => validateVoiceAudioUpload(Buffer.alloc(0), "audio/webm"),
    (err: unknown) => err instanceof VoiceUploadValidationError && err.code === "EMPTY_AUDIO",
  );
});

test("validateVoiceAudioUpload rejects an upload larger than the 5MB ceiling with AUDIO_TOO_LARGE", () => {
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  assert.throws(
    () => validateVoiceAudioUpload(oversized, "audio/webm"),
    (err: unknown) => err instanceof VoiceUploadValidationError && err.code === "AUDIO_TOO_LARGE",
  );
});

test("validateVoiceAudioUpload rejects a declared type outside the allowlist with UNSUPPORTED_AUDIO_TYPE", () => {
  assert.throws(
    () => validateVoiceAudioUpload(webmBytes(), "video/mp4"),
    (err: unknown) => err instanceof VoiceUploadValidationError && err.code === "UNSUPPORTED_AUDIO_TYPE",
  );
});

test("validateVoiceAudioUpload rejects bytes that don't match any recognised container with UNSUPPORTED_AUDIO_TYPE, even for an allowlisted declared type", () => {
  assert.throws(
    () => validateVoiceAudioUpload(Buffer.from("totally-unrecognised-bytes-here"), "audio/webm"),
    (err: unknown) => err instanceof VoiceUploadValidationError && err.code === "UNSUPPORTED_AUDIO_TYPE",
  );
});

test("validateVoiceAudioUpload rejects a declared type that does not match the detected container with AUDIO_TYPE_MISMATCH", () => {
  assert.throws(
    () => validateVoiceAudioUpload(webmBytes(), "audio/wav"),
    (err: unknown) => err instanceof VoiceUploadValidationError && err.code === "AUDIO_TYPE_MISMATCH",
  );
});

test("assertPlausibleAudioDuration accepts a byte count exactly at the plausible ceiling and rejects one byte over it", () => {
  const maxDurationSeconds = 1;
  const ceilingBytes = maxDurationSeconds * 5_000_000;
  assert.doesNotThrow(() => assertPlausibleAudioDuration(ceilingBytes, maxDurationSeconds));
  assert.throws(
    () => assertPlausibleAudioDuration(ceilingBytes + 1, maxDurationSeconds),
    (err: unknown) => err instanceof VoiceUploadValidationError && err.code === "AUDIO_DURATION_EXCEEDED",
  );
});

test("assertProviderReportedDurationWithinLimit passes through a null duration (nothing more precise to check)", () => {
  assert.doesNotThrow(() => assertProviderReportedDurationWithinLimit(null));
});

test("assertProviderReportedDurationWithinLimit accepts a duration exactly at the limit and rejects one over it", () => {
  assert.doesNotThrow(() => assertProviderReportedDurationWithinLimit(60));
  assert.throws(
    () => assertProviderReportedDurationWithinLimit(60.01),
    (err: unknown) => err instanceof VoiceUploadValidationError && err.code === "AUDIO_DURATION_EXCEEDED",
  );
});

test("assertProviderReportedDurationWithinLimit honours a custom maxDurationSeconds override", () => {
  assert.doesNotThrow(() => assertProviderReportedDurationWithinLimit(30, 30));
  assert.throws(
    () => assertProviderReportedDurationWithinLimit(30.5, 30),
    (err: unknown) => err instanceof VoiceUploadValidationError && err.code === "AUDIO_DURATION_EXCEEDED",
  );
});
