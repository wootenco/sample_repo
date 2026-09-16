/* Bundles the app into a single self-contained HTML file for publishing as
 * an Artifact, which supplies its own doctype/head/body wrapper. The repo
 * version in index.html stays the canonical source; this only inlines it. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(resolve(root, p), 'utf8');

const html = read('index.html');
const body = html.split('<body>')[1].split('<script src=')[0].trim();
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];

const scripts = ['js/data/words.js', 'js/data/examples.js', 'js/data/chunks.js',
                 'js/srs.js', 'js/coverage.js', 'js/app.js'];

const out = `<title>Mil Palabras</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fonts}
<style>
${read('css/styles.css')}
</style>

${body}

${scripts.map(s => `<script>\n${read(s)}\n</script>`).join('\n')}
`;

writeFileSync(resolve(root, 'build/milpalabras.html'), out);
console.log('built build/milpalabras.html', (out.length / 1024).toFixed(0) + 'KB');
