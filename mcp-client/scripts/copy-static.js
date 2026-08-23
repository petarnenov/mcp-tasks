// Copies the non-bundled assets next to the bundle esbuild produces.
//
// A three-line script rather than a shell `cp` in the Makefile: `cp -r` differs between GNU and
// BSD on whether it creates or replaces the destination directory, and this repo's Makefile
// already carries one note about macOS tool differences. Node is a dependency here anyway.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
for (const file of ['index.html', 'style.css']) {
    copyFileSync(`src/${file}`, `dist/${file}`);
}
console.log('copied index.html, style.css -> dist/');
