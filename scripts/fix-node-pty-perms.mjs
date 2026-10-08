#!/usr/bin/env node
// postinstall: give node-pty's spawn-helper its execute bit back.
// lib/pty-spawn-helper.js explains why. Never fails the install: a helper that
// can't be fixed is reported, and the bridge falls back to print mode at
// spawn time.
import { ensureSpawnHelperExecutable, resolveNodePtyDir, describeSpawnHelperResult } from '../lib/pty-spawn-helper.js';

try {
  const ptyDir = resolveNodePtyDir();
  if (ptyDir) {
    for (const line of describeSpawnHelperResult(ensureSpawnHelperExecutable({ ptyDir }))) {
      console.log(`[postinstall] ${line}`);
    }
  }
} catch (error) {
  console.warn(`[postinstall] node-pty spawn-helper check skipped: ${error?.message || error}`);
}
