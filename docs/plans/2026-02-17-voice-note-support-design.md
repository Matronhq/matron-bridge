# Voice Note Support Design

## Overview

Add inbound voice note transcription to the Matrix bridge. Users send voice messages in Matrix, the bridge transcribes them locally using whisper.cpp, and forwards the transcription to Claude with a label indicating it came from a voice note.

## Decisions

- **Direction:** Inbound transcription only (no text-to-speech responses)
- **Transcription engine:** whisper.cpp (C++ implementation), shelling out to the `whisper-cli` binary
- **Model:** `ggml-small.bin` (~466 MB, good accuracy for voice notes)
- **Installation:** Prebuilt release binary from GitHub, ffmpeg via apt. Install script lives in the bridge repo (`setup/install-whisper.sh`), called by Chef in yearbook-infra.
- **Presentation to Claude:** Labelled — `[Voice note transcription]: <text>`
- **User feedback:** Status message "Transcribing voice note..." edited to show "Transcribed: <preview>" on completion
- **No new npm dependencies**

## Architecture

```
User sends voice note (m.audio) in Matrix
  -> Bridge downloads & decrypts audio (existing downloadMatrixFile)
  -> Save to temp file in /tmp
  -> ffmpeg converts to 16kHz mono WAV
  -> whisper-cli transcribes WAV -> text
  -> Clean up temp files
  -> Edit status message: "Transcribed: <first 100 chars>..."
  -> Forward to Claude: "[Voice note transcription]: <text>"
```

## Code Changes

### 1. Message handler (~line 1768)

Add `m.audio` to recognized msgtypes alongside `m.image` and `m.file`:

```js
} else if (msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.audio') {
  hasMedia = true;
  text = (event.content.body || '').trim();
}
```

### 2. `buildMediaContentBlocks` function (~line 1145)

Add an `m.audio` branch before the existing `m.image` check:

- Downloads and decrypts the audio (existing code path)
- Calls new `transcribeAudio(buffer, mime)` helper
- Returns a text block: `[Voice note transcription]: <transcribed text>`
- Needs access to `sendHtml` for the status message — either passed as parameter or handled at the call site

### 3. New `transcribeAudio(buffer, mime)` helper

```
transcribeAudio(buffer: Buffer, mime: string) -> Promise<string>
```

- Determines file extension from MIME type (audio/ogg -> .ogg, audio/mp4 -> .mp4, etc.)
- Writes buffer to temp file: `/tmp/voice-<random>.<ext>`
- Runs: `ffmpeg -i <input> -ar 16000 -ac 1 -f wav <output.wav>`
- Runs: `whisper-cli -m <model-path> -f <output.wav> --no-timestamps -l <language>`
- Parses stdout text, trims whitespace
- Cleans up both temp files in a `finally` block
- Throws on failure (caller handles error messaging)

### 4. Status message flow

At the call site in the message handler (both the direct send path and the queue path):

- When `m.audio` is detected, send a notice: "Transcribing voice note..."
- After transcription completes, edit that message to: "Transcribed: <first 100 chars>..."
- If transcription fails, edit to: "Voice note transcription failed: <error>"

### 5. `.env` configuration

Two new optional variables:

```
WHISPER_MODEL_PATH=~/.local/share/whisper-cpp/ggml-small.bin
WHISPER_LANGUAGE=en
```

Both have sensible defaults so the bridge works without explicit configuration after running the install script.

### 6. `setup/install-whisper.sh`

Idempotent install script:

- Installs `ffmpeg` via apt (if not present)
- Clones and builds whisper.cpp from source (no Linux prebuilt binaries available)
- Downloads the `ggml-small.bin` model via the whisper.cpp model download script
- Places binaries and model in `~/.local/share/whisper-cpp/`
- Verifies installation by running `whisper-cli --help`

Chef in yearbook-infra runs this script as part of the `dev_server` cookbook setup.

### 7. `.env.example` update

Add the two new vars with comments explaining them.

## Error Handling

- If `whisper-cli` or `ffmpeg` is not installed: transcription fails, error message sent to room
- If transcription returns empty text: send "Could not transcribe voice note (empty result)"
- If ffmpeg conversion fails: send error with ffmpeg stderr
- All temp files cleaned up in `finally` blocks regardless of success/failure

## Files Modified

- `index.js` — Add `m.audio` handling, `transcribeAudio` helper, status messages
- `.env.example` — Add `WHISPER_MODEL_PATH`, `WHISPER_LANGUAGE`
- `setup/install-whisper.sh` — New file, whisper.cpp + ffmpeg installation

## System Requirements

- **ffmpeg:** via apt (Ubuntu 24.04)
- **whisper-cli:** built from source (no Linux prebuilt binaries available)
- **ggml-small.bin model:** ~466 MB
- **Disk:** ~500 MB total for binary + model
- **RAM:** ~1 GB during transcription (freed after)
- **CPU:** Brief spike during transcription, negligible for voice note lengths
