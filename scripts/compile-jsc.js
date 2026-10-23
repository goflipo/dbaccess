/**
 * Compiles sensitive Electron main-process modules to V8 bytecode (.jsc).
 *
 * MUST be run via Electron (not plain Node) so the bytecode matches the
 * exact V8 version bundled with Electron:
 *
 *   npx electron scripts/compile-jsc.js
 *
 * The build scripts in package.json do this automatically before packaging.
 * Re-run whenever you upgrade the electron version in package.json.
 */

const bytenode = require('bytenode');
const path     = require('path');
const fs       = require('fs');

const electronDir = path.join(__dirname, '..', 'electron');

// Files to compile — paths relative to electron/.
// ipc-handlers internally requires './database', which stays as JS.
const targets = ['license', 'ai', 'ipc-handlers'];

async function main() {
  let failed = false;

  for (const name of targets) {
    const src = path.join(electronDir, `${name}.js`);
    const out = path.join(electronDir, `${name}.jsc`);

    if (!fs.existsSync(src)) {
      console.error(`[JSC] Source not found: ${src}`);
      failed = true;
      continue;
    }

    try {
      await bytenode.compileFile({ filename: src, output: out });
      const kb = (fs.statSync(out).size / 1024).toFixed(1);
      console.log(`[JSC] ${name}.js  →  ${name}.jsc  (${kb} KB)`);
    } catch (err) {
      console.error(`[JSC] Failed to compile ${name}.js:`, err.message);
      failed = true;
    }
  }

  if (failed) {
    console.error('[JSC] Compilation failed — aborting build.');
    process.exit(1);
  }

  console.log('[JSC] All files compiled successfully.');

  // Quit Electron after compile (no-op under plain Node)
  try { require('electron').app.quit(); } catch { process.exit(0); }
}

main().catch(err => {
  console.error('[JSC] Unexpected error:', err.message);
  process.exit(1);
});
