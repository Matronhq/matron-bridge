import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

export const MIME_TO_EXT = {
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'audio/aac': '.aac',
  'audio/x-caf': '.caf',
};

export async function transcribeAudio(buffer, mime, { modelPath, language }) {
  const ext = MIME_TO_EXT[mime] || '.ogg';
  // mkdtemp gives us a private, unpredictably-named directory (0700) so the
  // audio files can't collide with or be pre-created by other local users.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  const inputPath = path.join(tmpDir, `input${ext}`);
  const wavPath = path.join(tmpDir, 'audio.wav');

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
    const whisperBin = path.join(path.dirname(modelPath), '../build/bin/whisper-cli');
    const { stdout } = await execFileAsync(
      whisperBin,
      ['-m', modelPath, '-f', wavPath, '--no-timestamps', '-l', language],
      { timeout: 120000 },
    );

    const text = stdout.replace(/\[.*?\]/g, '').trim();
    if (!text) throw new Error('empty transcription result');
    return text;
  } finally {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
