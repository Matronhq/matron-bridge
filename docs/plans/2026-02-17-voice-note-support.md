# Voice Note Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add inbound voice note transcription to the Matrix bridge using local whisper.cpp.

**Architecture:** When a user sends a voice note (`m.audio`) in Matrix, the bridge downloads the audio, converts it to 16kHz WAV via ffmpeg, transcribes it with whisper-cli, shows a status message, and forwards the labelled transcription to Claude. A setup script handles installing ffmpeg, building whisper.cpp, and downloading the model.

**Tech Stack:** Node.js (existing), whisper.cpp (C++ CLI), ffmpeg (apt)

---

### Task 1: Create the install-whisper.sh setup script

**Files:**
- Create: `setup/install-whisper.sh`

**Step 1: Write the install script**

```bash
#!/usr/bin/env bash
set -euo pipefail

WHISPER_VERSION="v1.8.3"
WHISPER_MODEL="small"
INSTALL_DIR="${WHISPER_INSTALL_DIR:-$HOME/.local/share/whisper-cpp}"
MODEL_FILE="ggml-${WHISPER_MODEL}.bin"

echo "=== Whisper.cpp Install ==="
echo "Version: $WHISPER_VERSION"
echo "Model: $WHISPER_MODEL"
echo "Install dir: $INSTALL_DIR"
echo

# Install system dependencies
echo "Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg cmake g++ 2>&1 | tail -1

# Clone or update whisper.cpp
if [ -d "$INSTALL_DIR" ]; then
  echo "Whisper.cpp directory exists, updating..."
  cd "$INSTALL_DIR"
  git fetch --tags
  git checkout "$WHISPER_VERSION"
else
  echo "Cloning whisper.cpp..."
  git clone --branch "$WHISPER_VERSION" --depth 1 https://github.com/ggerganov/whisper.cpp.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Build
echo "Building whisper.cpp..."
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j "$(nproc)"

# Verify binary
WHISPER_BIN="$INSTALL_DIR/build/bin/whisper-cli"
if [ ! -f "$WHISPER_BIN" ]; then
  echo "ERROR: whisper-cli binary not found at $WHISPER_BIN"
  exit 1
fi
echo "Binary: $WHISPER_BIN"
"$WHISPER_BIN" --help 2>&1 | head -1

# Download model if not present
if [ ! -f "$INSTALL_DIR/models/$MODEL_FILE" ]; then
  echo "Downloading $MODEL_FILE model..."
  bash "$INSTALL_DIR/models/download-ggml-model.sh" "$WHISPER_MODEL"
else
  echo "Model $MODEL_FILE already exists."
fi

echo
echo "=== Whisper.cpp install complete ==="
echo "Binary: $WHISPER_BIN"
echo "Model: $INSTALL_DIR/models/$MODEL_FILE"
```

**Step 2: Make it executable and verify it parses**

Run: `chmod +x setup/install-whisper.sh && bash -n setup/install-whisper.sh`
Expected: No output (clean parse)

**Step 3: Commit**

```bash
git add setup/install-whisper.sh
git commit -m "feat: add whisper.cpp install script for voice note support"
```

---

### Task 2: Run the install script to set up whisper.cpp on this machine

**Step 1: Run the install script**

Run: `bash setup/install-whisper.sh`
Expected: Installs ffmpeg, cmake, clones whisper.cpp v1.8.3, builds it, downloads ggml-small.bin model. Final output shows binary and model paths.

**Step 2: Verify whisper-cli works**

Run: `~/.local/share/whisper-cpp/build/bin/whisper-cli --help 2>&1 | head -3`
Expected: Shows whisper-cli usage/help text.

**Step 3: Verify ffmpeg works**

Run: `ffmpeg -version 2>&1 | head -1`
Expected: Shows ffmpeg version string.

---

### Task 3: Add .env config variables

**Files:**
- Modify: `.env.example` (append to end)
- Modify: `index.js:28-31` (config section)

**Step 1: Add vars to .env.example**

Append to `.env.example` after the last line:

```
# Voice note transcription (optional — requires whisper.cpp)
WHISPER_MODEL_PATH=
WHISPER_LANGUAGE=en
```

**Step 2: Add config constants to index.js**

Add after line 31 (`const SESSIONS_FILE = ...`):

```js
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || path.join(os.homedir(), '.local/share/whisper-cpp/models/ggml-small.bin');
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'en';
```

**Step 3: Add execFile import**

Change line 4 from:
```js
import { spawn } from 'child_process';
```
to:
```js
import { spawn, execFile } from 'child_process';
```

**Step 4: Commit**

```bash
git add .env.example index.js
git commit -m "feat: add whisper config variables and execFile import"
```

---

### Task 4: Implement the transcribeAudio helper function

**Files:**
- Modify: `index.js` (add function before the `// --- Media Handling ---` section at line 1118)

**Step 1: Add the transcribeAudio function**

Insert before line 1118 (`// --- Media Handling ---`):

```js
// --- Voice Note Transcription ---

const MIME_TO_EXT = {
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'audio/aac': '.aac',
  'audio/x-caf': '.caf',
};

async function transcribeAudio(buffer, mime) {
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const ext = MIME_TO_EXT[mime] || '.ogg';
  const id = Math.random().toString(36).slice(2, 10);
  const inputPath = path.join(os.tmpdir(), `voice-${id}${ext}`);
  const wavPath = path.join(os.tmpdir(), `voice-${id}.wav`);

  try {
    // Write audio buffer to temp file
    fs.writeFileSync(inputPath, buffer);

    // Convert to 16kHz mono WAV
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-y',
      wavPath,
    ], { timeout: 30000 });

    // Transcribe with whisper-cli
    const { stdout } = await execFileAsync(
      path.join(path.dirname(WHISPER_MODEL_PATH), '../build/bin/whisper-cli'),
      ['-m', WHISPER_MODEL_PATH, '-f', wavPath, '--no-timestamps', '-l', WHISPER_LANGUAGE],
      { timeout: 120000 },
    );

    const text = stdout.replace(/\[.*?\]/g, '').trim();
    if (!text) throw new Error('empty transcription result');
    return text;
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
}
```

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: add transcribeAudio helper function"
```

---

### Task 5: Add m.audio handling to buildMediaContentBlocks

**Files:**
- Modify: `index.js:1156-1161` (inside `buildMediaContentBlocks`)

**Step 1: Add m.audio branch**

In `buildMediaContentBlocks`, change the if/else starting at line 1156 from:

```js
  if (content.msgtype === 'm.image') {
```

to:

```js
  if (content.msgtype === 'm.audio') {
    const transcription = await transcribeAudio(buffer, mime);
    blocks.push({ type: 'text', text: `[Voice note transcription]: ${transcription}` });
  } else if (content.msgtype === 'm.image') {
```

This inserts the audio branch before the existing image handling. The download and decryption already happened at line 1152. The transcription result becomes a text block forwarded to Claude.

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: add m.audio transcription in buildMediaContentBlocks"
```

---

### Task 6: Add m.audio to the message handler msgtype check

**Files:**
- Modify: `index.js:1770` (message handler)

**Step 1: Extend the msgtype condition**

Change line 1770 from:

```js
  } else if (msgtype === 'm.image' || msgtype === 'm.file') {
```

to:

```js
  } else if (msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.audio') {
```

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: recognize m.audio msgtype in message handler"
```

---

### Task 7: Add status message feedback for voice note transcription

**Files:**
- Modify: `index.js` (the two `hasMedia` handling blocks — direct send path ~line 1900 and queue path ~line 1865)

**Step 1: Add status messages to the direct send path**

Replace the `hasMedia` block at ~line 1900-1918:

```js
  if (hasMedia) {
    try {
      // Show transcription status for voice notes
      let statusEventId = null;
      if (msgtype === 'm.audio') {
        const transcribeNotice = notice('info', 'Transcribing voice note...', 'Transcribing voice note…');
        statusEventId = await sendHtmlFn(transcribeNotice.plain, transcribeNotice.html);
      }

      const blocks = await buildMediaContentBlocks(event, session);
      if (blocks.length === 0) {
        if (statusEventId) await editMessage(roomId, statusEventId, 'Voice note transcription failed', notice('error', 'Voice note transcription failed', 'Voice note transcription failed').html);
        else await sendReply('Could not process the file.');
        return;
      }

      // Update status with transcription preview
      if (statusEventId && msgtype === 'm.audio') {
        const transcriptionBlock = blocks.find(b => b.type === 'text' && b.text.startsWith('[Voice note transcription]'));
        if (transcriptionBlock) {
          const preview = transcriptionBlock.text.replace('[Voice note transcription]: ', '');
          const truncated = preview.length > 100 ? preview.slice(0, 97) + '…' : preview;
          const doneNotice = notice('success', `Transcribed: ${truncated}`, `Transcribed: ${escapeHtml(truncated)}`);
          await editMessage(roomId, statusEventId, doneNotice.plain, doneNotice.html);
        }
      }

      if (!sendToSession(session, blocks)) {
        await sendReply('Session is not available. Send !start to begin a new one.');
      } else if (!session.firstMessageCaptured) {
        session.firstMessageCaptured = true;
        const fileName = event.content.body || 'file';
        const label = `${SERVER_LABEL}: ${fileName.slice(0, 50)}`;
        updateRoomName(session.roomId, label);
      }
    } catch (err) {
      console.error('Media processing error:', err);
      await sendReply(`Failed to process file: ${err.message}`);
    }
```

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: add transcription status messages for voice notes"
```

---

### Task 8: Test end-to-end with a real voice note

**Step 1: Restart the bridge**

Run: `sudo systemctl restart claude-matrix-bridge` (or however the service is managed)

**Step 2: Send a voice note**

Send a voice note from a Matrix client (Element) to the bridge bot. Verify:
1. Bot sends "Transcribing voice note..." status message
2. Status message gets edited to "Transcribed: <preview text>"
3. Claude receives and responds to the transcribed content
4. Sending a regular text message still works
5. Sending an image still works

**Step 3: Test error case**

Temporarily rename the whisper-cli binary and send another voice note. Verify the bridge sends an error message to the room instead of crashing.

---

### Task 9: Final commit and cleanup

**Step 1: Review all changes**

Run: `git diff HEAD~6` to review all changes made across the tasks.

**Step 2: Verify no leftover temp files**

Run: `ls /tmp/voice-*` — should show "No such file" (all cleaned up).

**Step 3: Update the design doc note about prebuilt binaries**

The design doc says "prebuilt release binary" but we discovered there are no Linux prebuilts — update the design doc to say "built from source" instead.

**Step 4: Commit design doc fix**

```bash
git add docs/plans/2026-02-17-voice-note-support-design.md
git commit -m "docs: update design doc — whisper.cpp built from source (no Linux prebuilts)"
```
