// 静的ホスティングへ上げる一式を site/ に組み立てる。
// esbuild が作るのは dist/bundle.js だけなので、index.html・アセット・画像・
// 配信設定（_redirects / _headers）をここで集める。
import { cp, mkdir, rm } from 'node:fs/promises';

const OUT = 'site';
// dist はディレクトリごとではなく bundle.js だけ。ソースマップは 7MB あって、
// 配信する意味がないわりに帯域を食う
const ENTRIES = [
  ['index.html', 'index.html'],
  ['dist/bundle.js', 'dist/bundle.js'],
  ['assets', 'assets'],
  ['images', 'images'],
  ['_redirects', '_redirects'],
  ['_headers', '_headers']
];

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/dist`, { recursive: true });

for (const [from, to] of ENTRIES) {
  await cp(from, `${OUT}/${to}`, { recursive: true });
}

console.log(`${OUT}/ に配信物を作成しました`);
