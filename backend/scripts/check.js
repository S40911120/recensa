'use strict';
// Backend type-check: syntax check of every src/**/*.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'src');
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.name.endsWith('.js')) {
      try { execSync(`node -c "${f}"`, { encoding: 'utf8', stdio: 'pipe' }); }
      catch (err) { console.error(err.message.slice(0, 200)); process.exit(1); }
    }
  }
}
walk(ROOT);
console.log('BE type-check OK');
