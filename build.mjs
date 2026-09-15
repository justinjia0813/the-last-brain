import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await build({ entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'], format: 'cjs', target: 'es2022', outfile: 'main.js' });
await mkdir('release/the-last-brain', { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(file, `release/the-last-brain/${file}`);
