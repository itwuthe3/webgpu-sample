# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Three.js の 3D サンプル集。**2系統が同居している**点がこのリポジトリの一番の特徴。

| | 実装 | サンプル |
|---|---|---|
| WebGL 系 | React Three Fiber + drei | `/ocean`, `/text-input-3d` |
| WebGPU 系 | 素の Three.js + `three/webgpu` + TSL | `/flame`, `/komorebi`, `/water-caustics` |

同じ three パッケージを共有しているが、**R3F は WebGPU 側では一切使っていない**。
WebGPU サンプルは `WebGPUCanvas` が非同期初期化と描画ループを引き受け、その中で普通に
`new Mesh(...)` していく素の Three.js コードになっている。

## コマンド

```bash
npm install
npm run build          # esbuild で src/index.tsx → dist/bundle.js にバンドル
node server.js         # http://localhost:3000 で静的配信
npx tsc --noEmit       # 型チェック（build には含まれないので別途実行する）
```

- テスト・リンタの設定は存在しない。
- `npm run build` は esbuild のみ。**esbuild は型チェックをしない**ため、型エラーはビルドを通過する。
  変更後は `npx tsc --noEmit` を明示的に走らせる。
- ウォッチモードは無い。変更のたびに `npm run build` を再実行してブラウザをリロードする
  （`server.js` は再起動不要）。

## アーキテクチャ

エントリは [src/index.tsx](src/index.tsx) → [src/App.tsx](src/App.tsx)。`App.tsx` が
react-router-dom でサンプルを振り分ける唯一のハブで、サンプルを追加するときは
「`/` のリンク一覧」と「`<Route>`」の両方に追記する。

### WebGL 系（React Three Fiber）

Canvas の持ち方がサンプルごとに違うので注意：

- **`/ocean`** — `App.tsx` 側の `OceanScene` が `<Canvas>` と `<OrbitControls>` を持ち、
  [Ocean.tsx](src/components/Ocean.tsx) はシーンの中身だけを返す。
  `three/examples/jsm` の `Water` / `Sky` を `extend({ Water, Sky })` で登録し、
  `<water>` / `<sky>` という小文字の JSX 要素として使う。これらの型は同ファイル内の
  `declare global { namespace JSX { ... } }` で `any` 宣言されている（新規 `extend` 時も同様に必要）。
  水面ノーマルマップは threejs.org から実行時に取得する外部依存。
- **`/text-input-3d`** — [TextInput3D.tsx](src/components/TextInput3D.tsx) が自前で `<Canvas>` と
  DOM のオーバーレイまで持つ完結したページ。`useFrame` 内で 5000 個の `bufferAttribute` の
  Float32Array を直接書き換えている（書き換えたら `needsUpdate = true` が要る）。

### WebGPU 系（TSL）

[src/components/webgpu/](src/components/webgpu/) 配下。

- [WebGPUCanvas.tsx](src/components/webgpu/WebGPUCanvas.tsx) — 共通の土台。
  `WebGPURenderer` の初期化は非同期（`await renderer.init()`）なので、各サンプルは
  シーン構築を `setup(ctx)` に切り出し、初期化完了後に呼んでもらう。返した
  `{ update, render, dispose }` が描画ループと後始末に使われる。`render` を返すと
  既定の `renderer.render()` を差し替えられる（ポストエフェクト用）。FPS 表示と
  WebGPU 非対応時のフォールバック表示もここ。
- サンプル本体は `setup` 関数ひとつ + 薄い React ラッパー、という形に揃えている。
  `setup` は `useCallback` で固定して渡す（毎回作り直すとシーンが再構築される）。
- オブジェクトはすべて外部アセット。[assets/polyhaven/](assets/polyhaven/) に Poly Haven の
  **CC0** 素材（木・林床・切り株・倒木・岩・薪）を同梱しており、実行時に外部へ取りに行くことはない。
  取得元と再取得方法は [assets/polyhaven/CREDITS.md](assets/polyhaven/CREDITS.md)。合計 70MB。
- **glTF から読み込んだマテリアルはそのままでは使わない。** 各サンプルの `adopt()` で
  ノードマテリアルに差し替え、そのシーンの陰影関数（木漏れ日は `litSurface()`、
  水面は `underwater()`）で塗り直している。こうしないと読み込んだ物だけがライティングから外れる。
- **セットもの（`rock_moss_set_*` など）の glTF は、岩が並べて配置されている。** 子ノードの原点は
  セット内での位置なので、そのまま `position` を与えるとその分ずれて浮く。`WaterCaustics.tsx` の
  `adopt()` のように `Box3` で 1 個ずつ原点へ寄せ直してから使うこと。

[Komorebi.tsx](src/components/webgpu/Komorebi.tsx) だけは構造が一段複雑で、
**太陽の位置に置いた `OrthographicCamera` から葉だけを `RenderTarget` に描いて、
自前の影マップを毎フレーム焼いている**。

- 木は 1 本 107万三角形。影マップに描くのは手前の8本だけで（`leaves.layers.enable(1)` と
  `sunCamera.layers.set(1)`）、中景・遠景は影を落とさない。木を増やすとここが素直に重くなる。
- **焼くときは `scene.overrideMaterial` ではなく、メッシュ1枚ずつマテリアルを差し替える。**
  葉と幹で抜き（alphaTest）が違うため、1枚のマテリアルでは代用できない。差し替え対象は
  `shadowCasters` に集めてある。
- 葉のアルファは glTF に入っていない（テクスチャが jpg なので）。
  `island_tree_02_leaves_alpha_1k.jpg` を別途読んで `opacityNode` に使う。
- 葉の風はモデルローカル座標のノイズ。マスク用マテリアルと `positionNode` を共有しているので、
  葉が揺れれば影も揺れる。
- 地面・幹・光の柱・塵は、そのマップを `lightAt()` / `softLightAt()` で引くだけ。
  ひとつのマップから木漏れ日のすべてが導かれる。
- `scene.background` は使わない（設定すると影マップのパスでも背景が描かれてしまう）。
  空は BackSide の球メッシュで描いている。

TSL を書くうえでの実際にハマった点：

- **`setup` は async にできる。** アセットの読み込みは `setup` の先頭で `await` すればよい
  （`WebGPUCanvas` 側が待つ）。失敗すると画面にエラーが出る。
- **`toVar()` / `If()` / `Loop()` は `Fn()` の中でしか使えない。**
  マテリアルのノードを組み立てるときも `material.colorNode = Fn(() => { ... })()` と包む。
  外で書くとエラーにならず、その部分が黙ってシェーダーから消える。
- **ストレージバッファの `vec3` は `vec4` にパディングされる。** `instancedArray(n, 'vec3')`
  を `toAttribute()` した値をそのまま `vec4(value, 1.0)` に渡すと、成分が5つになって
  `TSL: Length of parameters exceeds maximum length` になる。`value.xyz` と明示すること。
- TSL のエラーは出どころが分からないことが多い。`Node.captureStackTrace = true` を立てて
  `npx esbuild ... --bundle --sourcemap`（`--minify` なし）でビルドすると、スタックが取れる。
- ポストエフェクトのクラスは `PostProcessing` ではなく **`RenderPipeline`**（r185 で改名済み）。
  `pass(scene, camera).getTextureNode('output')` を bloom に通して `outputNode` に入れる。
- **コンピュートは毎フレーム `renderer.compute(node)` を呼ぶ。** 初期化パスだけは
  `renderer.computeAsync(node)` を setup 内で1回。
- ping-pong が要る計算（[WaterCaustics.tsx](src/components/webgpu/WaterCaustics.tsx) の波動方程式）は、
  1フレームに2ステップ進めて必ず同じバッファが最新になるようにしてある。描画側は片方だけ見ればよい。
- 粒子の描画は `Sprite` + `SpriteNodeMaterial` に `positionNode = buffer.toAttribute()` を挿し、
  `sprite.count = PARTICLE_COUNT` で個数を決める（`frustumCulled = false` も必要）。
- **整数ノードの `min` / `max` は `@types/three` に型が無い。**`WaterCaustics.tsx` の
  `clampIndex` のように、そこだけ型を緩めたヘルパーに閉じ込める。
- シェーダー組み立て用ヘルパーの引数は `type TSLNode = any` で受けている。TSL のノード型は
  構造的に厳密すぎて、汎用ヘルパーに正しい型を付けるのが現実的でないため。

パフォーマンスの内訳はサンプルごとに違う。炎と水面はフィルレート律速で、粒子数を増やすより
スプライトを小さくするほうが効く。木漏れ日は木のポリゴン数律速で、影マップに描く本数
（`NEAR_TREES`）がそのまま効く。光の柱のレイマーチはレイ1本につき26回サンプルするが、
影マップのテクスチャ読みなので安い（ノイズを直接評価していた頃は同じ設定で 1/10 以下の fps だった）。

## 既知の制約

- **SPA フォールバックが無い。** [server.js](server.js) はパスをそのままファイルパスに解決する素朴な
  静的サーバーなので、`http://localhost:3000/flame` に直接アクセスしたりリロードすると 404 になる。
  必ず `/` から画面内のリンクで遷移すること。
- `server.js` は拡張子 `.js` のリクエストを自動で `/dist` 配下に振り替える（`index.html` が
  `dist/bundle.js` を読むのはこの仕組みに乗っている）。
- `three` と `three/webgpu` の両方をバンドルしているため、`dist/bundle.js` は 1.8MB ほどある。
- 波動方程式は固定ステップで、フレームレートに依存する（低 fps だと波がゆっくりになる）。
- `index.tsx` は React 18 環境で React 17 の `ReactDOM.render` を使っており、起動時に警告が出る。
- コード・コメント・ログはすべて日本語。既存のスタイルに合わせる。

## 依存関係のバージョン事情

WebGPU/TSL のために three を r185 に上げた際、以下が芋づるで必要になった。下げるときは逆順に注意。

- `three-stdlib` — drei が使う。2.33 は r185 で削除された `LuminanceFormat` を import していてビルドが落ちる。
- `@types/three` — `three/webgpu` と `three/tsl` の型は 0.185 系にしか入っていない。
- `typescript` — 上記の型定義が TS 5 系の構文を使っているため 4.9 では構文エラーになる。
- `tsconfig.json` の `moduleResolution` は `bundler`。`node` のままだと `three/webgpu` を解決できない。
