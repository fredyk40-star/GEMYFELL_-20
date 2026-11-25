import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());

function jsFiles(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) return jsFiles(relative);
    return entry.name.endsWith('.js') ? [relative] : [];
  });
}

const files = ['app.js', 'sw.js', ...jsFiles('api'), ...jsFiles('lib')];
for (const file of files) {
  execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
}
console.log(`Syntax OK: ${files.length} JavaScript files`);
