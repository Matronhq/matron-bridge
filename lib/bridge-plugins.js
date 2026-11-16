// Bridge plugins: operator-installed ES modules that add RPC methods.
//
// MATRON_BRIDGE_PLUGINS is a comma-separated list of absolute module paths,
// empty by default and read once at startup. A plugin runs inside the bridge
// process with every privilege the bridge has, so the loader is strict about
// where a module may live: it refuses a relative path, a file under a
// session folder, a file the bridge's user does not own, and a file that
// group or others can write. The checks run on the resolved file (symlinks
// followed), and that same resolved path is the one imported.
//
// A module's default export is `register(api)`, returning
// `{ name, handlers: { x_<name>_<method>: fn(params, { request }) } }`.
// `name` is lowercase letters and digits. Handlers return the result (or a
// promise of it); lib/journal-rpc.js answers, wraps and collision-checks them.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const NAME_RE = /^[a-z][a-z0-9]{0,31}$/;
const METHOD_TAIL_RE = /^[a-z0-9_]+$/;

const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const isUnder = (file, dir) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// Why `file` may not be loaded, or null. `forbiddenDirs`: the default folder
// and every session folder.
export function pluginPathRefusal(file, { forbiddenDirs = [], uid = process.getuid?.() } = {}) {
  if (!path.isAbsolute(file)) return 'path is not absolute';
  if (uid === undefined) return 'cannot check file ownership on this platform';
  let link;
  let real;
  try {
    link = fs.lstatSync(file);
    real = fs.realpathSync(file);
  } catch (e) {
    return `cannot read the file (${e.code || e.message})`;
  }
  if (link.isSymbolicLink() && link.uid !== uid) return 'symlink is not owned by the bridge user';
  const st = fs.statSync(real);
  if (!st.isFile()) return 'not a regular file';
  if (st.uid !== uid) return 'file is not owned by the bridge user';
  if (st.mode & 0o022) return 'file is writable by group or others';
  for (const dir of forbiddenDirs) {
    const dirs = [path.resolve(dir), realOrNull(dir)].filter(Boolean);
    if (dirs.some((d) => isUnder(real, d) || isUnder(path.resolve(file), d))) return `file is under a session folder (${dir})`;
  }
  return null;
}

// Loads every module named in env.MATRON_BRIDGE_PLUGINS. A refused or broken
// plugin is logged and skipped; the bridge still starts. Returns
// [{name, file, handlers}].
export async function loadBridgePlugins({ env = process.env, forbiddenDirs = [], log = console, uid } = {}) {
  const list = (env.MATRON_BRIDGE_PLUGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const loaded = [];
  for (const file of list) {
    const refuse = (why) => log.warn?.(`[bridge-plugins] refused ${file}: ${why}`);
    const bad = pluginPathRefusal(file, { forbiddenDirs, ...(uid === undefined ? {} : { uid }) });
    if (bad) { refuse(bad); continue; }
    try {
      const mod = await import(pathToFileURL(fs.realpathSync(file)).href);
      if (typeof mod.default !== 'function') { refuse('no default export register(api)'); continue; }
      const out = await mod.default({ log });
      const name = out?.name;
      if (typeof name !== 'string' || !NAME_RE.test(name)) { refuse('name must be lowercase letters and digits'); continue; }
      if (loaded.some((p) => p.name === name)) { refuse(`plugin name ${name} already loaded`); continue; }
      const prefix = `x_${name}_`;
      const methods = out.handlers && typeof out.handlers === 'object' ? Object.entries(out.handlers) : [];
      const badMethod = methods.find(([m, fn]) => !m.startsWith(prefix) || !METHOD_TAIL_RE.test(m.slice(prefix.length)) || typeof fn !== 'function');
      if (badMethod) { refuse(`method ${badMethod[0]} must be a function named ${prefix}<method>`); continue; }
      loaded.push({ name, file, handlers: Object.fromEntries(methods) });
    } catch (e) {
      refuse(`failed to load: ${e?.message ?? String(e)}`);
    }
  }
  return loaded;
}
