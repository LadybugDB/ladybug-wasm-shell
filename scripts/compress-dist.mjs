import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createBrotliCompress, createGzip, constants } from 'node:zlib';

const DIST_DIR = 'dist';
const MIN_BYTES = 1024;
const COMPRESSIBLE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.svg',
  '.txt',
  '.wasm',
  '.xml',
]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

async function compressFile(path) {
  await pipeline(
    createReadStream(path),
    createGzip({ level: 9 }),
    createWriteStream(`${path}.gz`),
  );

  await pipeline(
    createReadStream(path),
    createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
    createWriteStream(`${path}.br`),
  );
}

let compressedCount = 0;

for await (const path of walk(DIST_DIR)) {
  if (path.endsWith('.gz') || path.endsWith('.br')) {
    continue;
  }

  if (!COMPRESSIBLE_EXTENSIONS.has(extname(path))) {
    continue;
  }

  if (statSync(path).size < MIN_BYTES) {
    continue;
  }

  await compressFile(path);
  compressedCount += 1;
}

console.log(`Compressed ${compressedCount} dist asset${compressedCount === 1 ? '' : 's'}.`);
