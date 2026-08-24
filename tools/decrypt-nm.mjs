// Node side of the node_modules "decrypt" pipeline.
// Reads every file under node_modules with node's fs (which the machine's
// transparent-encryption filter driver decrypts for the node process) and
// streams {path, base64} NDJSON lines to stdout. The PowerShell side writes
// them back as plaintext so non-node tools (esbuild.exe, cmd shims) can read.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || 'node_modules';
let count = 0;
let bytes = 0;

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(fp);
    } else if (e.isFile()) {
      try {
        const buf = fs.readFileSync(fp);
        process.stdout.write(JSON.stringify({ p: fp, d: buf.toString('base64') }) + '\n');
        count++;
        bytes += buf.length;
      } catch (err) {
        process.stderr.write(`SKIP ${fp}: ${err.message}\n`);
      }
    }
  }
}

walk(root);
process.stderr.write(`DONE files=${count} bytes=${bytes}\n`);
