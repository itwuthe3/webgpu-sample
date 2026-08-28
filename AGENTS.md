# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 概要

Three.js の 3D サンプル集。サンプルは**すべて WebGPU**（`three/webgpu` + TSL）で、
React は入口（react-router での振り分けと一覧ページ）にしか使っていない。

| サンプル | 主題 |
|---|---|
| `/komorebi` | 太陽から焼いた自前の影マップ1枚で、光斑・光の柱・塵をすべて導く |
| `/water-caustics` | 波動方程式を解き、水面のきらめきと水底の集光を同じ高さ場から出す |
| `/flame` | 焚き火。炎はレイマーチ、火の粉は粒子 |
| `/candle` | 炎を発光する媒質としてレイマーチするロウソクの火（外部アセットなし） |
| `/text-input-3d` | 入力した文字の形へ6.5万個の粒子を集め、Enter で爆散させる |

各サンプルは `WebGPUCanvas` に非同期初期化と描画ループを任せ、その中で普通に
`new Mesh(...)` していく素の Three.js コードになっている。

以前は React Three Fiber + drei の WebGL サンプル（`/ocean`）が同居していたが削除済み。
`@react-three/*` / `@react-spring/three` / `three-stdlib` は package.json に残っているだけで、
もうどこからも import していない。

## コマンド

```bash
npm install
npm run build          # esbuild で src/index.tsx → dist/bundle.js にバンドル
node server.js         # http://localhost:3000 で静的配信
npx tsc --noEmit       # 型チェック（build には含まれないので別途実行する）

npm run build:site     # 公開用の一式を site/ に組み立てる（Cloudflare Pages の出力先）
npx wrangler pages dev site   # 配信物を _redirects 込みで確認する
```

- テスト・リンタの設定は存在しない。
- `npm run build` は esbuild のみ。**esbuild は型チェックをしない**ため、型エラーはビルドを通過する。
  変更後は `npx tsc --noEmit` を明示的に走らせる。
- ウォッチモードは無い。変更のたびに `npm run build` を再実行してブラウザをリロードする
  （`server.js` は再起動不要）。

## アーキテクチャ

エントリは [src/index.tsx](src/index.tsx) → [src/App.tsx](src/App.tsx)。`App.tsx` は
react-router-dom で振り分けるだけで、`/` の一覧ページは
[src/components/Launcher.tsx](src/components/Launcher.tsx) が持っている。サンプルを追加するときは
`App.tsx` の `<Route>` と、`Launcher.tsx` の `SAMPLES` 配列の両方に追記する。

`Launcher.tsx` はホバーとメディアクエリを使うので、インラインスタイルではなく
コンポーネント内の `<style>`（`STYLES` 定数）に CSS をまとめている。カードのサムネイルは
[images/](images/) の実スクリーンショットで、画像が無いサンプルは accent 色のグラデーションで代用する。

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
  取得元と再取得方法は [assets/polyhaven/CREDITS.md](assets/polyhaven/CREDITS.md)。合計 32MB。
- **glTF は meshopt で圧縮済み**（`EXT_meshopt_compression` + `KHR_mesh_quantization`）。
  木は 39MB → 9MB。**素の `new GLTFLoader()` で読むと失敗する**ので、必ず
  [gltf.ts](src/components/webgpu/gltf.ts) の `createGLTFLoader()` を使う。
  アセットを差し替えるときは `npx @gltf-transform/cli meshopt in.gltf out.gltf` を通すこと。
- **glTF から読み込んだマテリアルはそのままでは使わない。** 各サンプルの `adopt()` で
  ノードマテリアルに差し替え、そのシーンの陰影関数（木漏れ日は `litSurface()`、
  水面は `underwater()`）で塗り直している。こうしないと読み込んだ物だけがライティングから外れる。
- **セットもの（`rock_moss_set_*` など）の glTF は、岩が並べて配置されている。** 子ノードの原点は
  セット内での位置なので、そのまま `position` を与えるとその分ずれて浮く。`WaterCaustics.tsx` の
  `adopt()` のように `Box3` で 1 個ずつ原点へ寄せ直してから使うこと。

[TextParticles.tsx](src/components/webgpu/TextParticles.tsx) と
[Candle.tsx](src/components/webgpu/Candle.tsx) は、外部アセットを使わない2本。

- **文字は裏キャンバスに 2D で描いてから粒子に配る。** 光ったピクセルを粒子の目的地として
  RGBA float の `DataTexture` に焼き、コンピュート側は `textureLoad` で引く。キー入力のたびに
  CPU 側から書き換えるので、ストレージバッファではなくテクスチャにしてある（`needsUpdate` だけで済む）。
- **見えていない粒子はスプライトを潰しておく。** 文字が空のとき6.5万枚が原点に重なると、
  そこだけで塗り潰しが破綻して 60fps を割った。`scaleNode` に不透明度を掛けて回避している。
- **ロウソクと焚き火の炎は、どちらも粒子ではなくレイマーチで描いている。**
  発光する参加媒質として `BoxGeometry`（`BackSide`）の中を積分する。理由は共通で、
  **拡散炎が光るのは燃料と空気が出会う「面」の上だけ**だから。粒子はその面を離散的に
  拾うことしかできず、22万個まで増やしても点の集まりのままだった。以前の粒子版は git 履歴にある。
- **ただし火の粉は粒子のまま。** あれは本当に離散した炭素の粒なので、粒子が正しい表現。
  「全部レイマーチ」ではなく、対象が連続体か離散体かで分けること。
- 焚き火の箱は炎よりずっと大きいので、**外形の外ではノイズを引かない**（`If` で囲う）のと、
  透過率が落ちたら `Break()` する（早期打ち切り）のが効く。これが無いと 1/3 の fps になる。
- 膜が「点々」に見えるときは、ノイズの特徴長が炎の幅に対して大きすぎる。
  炎の幅 0.5 に対して周波数 1.9（特徴長 0.5）では折り目が1つも入らない。4〜10 まで上げる。
- **焚き火の外形は、軸対称な涙型をひとつ置いてはいけない。** それはロウソクの形で、
  大きくしても焚き火には見えない。`FLAME_ROOTS` のように薪ごとの火を置いて union を取り、
  上のほうでプルームに合流させる。輪郭には方位と高さで波打つ凹凸（`ragged`）も足す。
- **上のプルームを別に用意してフェードインさせてはいけない。** 合流して細くなった柱より
  太いものが途中から現れるので、そこが不自然な膨らみになる（実際にやって指摘された）。
  合流した根元そのものがプルームになるのが正しく、背の高い火だけが上まで残るので
  先端は勝手に細って千切れる。**高さごとの幅を測って、単調に細っているか確認すること。**
- **ただし union を取るだけでは足りない。近接した炎は独立に振る舞わない。**
  内側どうしのせん断層が干渉して間の空気の巻き込みが妨げられるので、
  (1) 互いに引き寄せ合って上で合流し、(2) 空気不足で背が高くなり、(3) 位相が揃う。
  実装では `convergence` で重心へ寄せ、`MERGE_LIFT` で背を伸ばし、位相は重心からの距離に
  比例したわずかな遅れだけにしてある。
- **位相を揃えるか反転させるかは間隔で決まる。近いと同位相、離れると逆位相。**
  ここでは根元の間隔が径の 0.2〜1.3 倍で同位相の領域なので揃える。
  適当な位相をばらばらに与えるのは「離れていて結合していない」状態の表現になってしまう。
- **レイマーチの箱は「前面」を描くこと（`side` は既定のまま）。** 背面を描くと
  フラグメントの深度が箱の裏面＝薪よりずっと奥になり、薪が手前にあるピクセルで炎が
  丸ごと消える（薪を舐める炎まで巻き添え）。かといって `depthTest: false` にすると、
  今度は地面の下の炎が岩越しに透けて箱の底が板に見える。前面なら深度が箱の手前になるので、
  薪は炎を隠さず、手前の岩はきちんと隠す。カメラが箱に入らないことだけ
  `controls.minDistance` で担保しておく。
- 前面を描く場合、入口はフラグメント自身、出口は AABB の**遠い側**の交点になる（背面の逆）。
- **風は「時刻だけの関数」にする。** そうすると上昇の遅れ（高さ h の空気は τ = h/v 秒前に
  根元で受けた風になびいている）が、単に t - τ を渡すだけで表せる。位置に依存させると
  この手が使えなくなる。
- 遅れをずらした風をシェーダーで毎ステップ評価すると、空のステップまでノイズを引くことに
  なって重い。**CPU 側で4点ぶんだけ評価して uniform で渡し、シェーダーは高さで補間するだけ**にする。
- **突風はしきい値で切って作る。** サインの和をそのまま使うと always-on の揺れになり、
  「風が吹いている」ようには見えない。`max(0, raw - 0.06)` を 1.3 乗して、静穏 6 割・
  平均 5 秒の突風が 12 秒に 1 回。**二乗まで効かせると中くらいの風がほとんど潰れて、
  「たまに少し揺れるだけ」になる**ので指数は上げすぎないこと。
- **靡いて見えるかどうかは、頻度ではなく振幅で決まる。** 穂先の横ずれが炎の幅の 1/3
  （傾き 11 度）では風に見えない。`WIND_BEND` は炎の高さの 8 割ほど取って、
  最大 40 度・ふつうの突風で 15 度ぐらいにする。
- **倒れるぶんを見越して箱を大きく取ってはいけない。** ステップ数は固定なので、箱を広げると
  レイの行程が伸びて刻みが粗くなり、膜が潰れる。箱は静穏時の大きさだけ持ち、
  `boxMin` / `boxMax` を uniform にして毎フレーム風下へずらす（メッシュの transform も一緒に）。
- 箱は**縦方向も**足りているか確認する。突風のとき炎は 25% 伸びるので、
  その上端より高く取っていないと穂先が平らに切れる。
- 炎の裾は薪の高さより下から出さない。低いところに残すと、手前の岩との境界で
  箱の切り口が明るい塊として見える。
- キャンバスの読み戻し（`drawImage` → `getImageData`）は **rAF の直後でないと真っ黒になる**。
  `setTimeout` で回すと全サンプルが 0 になるので、必ず `requestAnimationFrame` に同期させること。
- レイは**ワールド座標**で進める。背面を描いているので出口はフラグメント自身、入口は
  ワールド空間の AABB とのスラブ交差で求める。ローカル座標に落とすとカメラ位置の変換が要るが、
  箱は回転も拡大もしないのでワールドのままでよい。
- **色は温度場から黒体放射で出す。** 実装は [blackbody.ts](src/components/webgpu/blackbody.ts) に
  切り出してあり、焚き火（/flame）と共用している。色温度→RGB の近似式の係数は sRGB 値なので、
  リニア空間で使うには `pow(g, 2.2)` でガンマを戻すこと。戻さないと黄色すぎる。
  先端の白は「白い色」ではなく、T^4 で効く明るさがトーンマッピングで飽和した結果。
  **温度を変えるだけで炎の種類が変わる。** ロウソクは 1120〜1820K、薪の輝炎は 920〜1480K。
  焚き火のほうが赤く見えるのは、この差がそのまま出ているだけ。
- 根元の青は熱放射ではなく CH*/C2* の化学発光。黒体放射とは別に、反応帯の薄い殻として足す。
- **1本のロウソクを常時ちらつかせてはいけない。** 9〜13Hz の自励振動は臨界サイズを超えた炎
  （ロウソクなら3本以上を束ねて融合させた場合）のもので、1本の炎の振動は過渡的にしか起きない。
  常時 11Hz で震わせると「ブルブル震えている」と即座に見破られる。11Hz 成分は
  `RESIDUAL_FLICKER`（0.012）の残差として置き、息を吹きかけたときだけ `disturbance` で
  立ち上げること。
- **逆に、焚き火（/flame）は臨界サイズの内側なので常時脈打つ。** f ≈ 1.5/√D がそのまま効き、
  火床の直径 0.8m から 1.7Hz が出る（`PUFF_HZ` は定数ではなく `BASE_RADIUS` から計算している）。
  **同じ法則でも、スケールによって結論が逆になる**ので、規模を確かめてから適用すること。
- **静穏時に見えている動きは 0.1〜0.7Hz のなびき。** `sin` の引数は rad/s なので、
  Hz のつもりで 0.3 と書くと 0.05Hz（周期20秒）になり、止まって見える。2π 倍を忘れない。
- **なびきには上昇の遅れを入れる。** 炎はプルームなので、高さ h の位置は根元が
  τ = h·H/v 秒前にした動きをなぞる（v ≒ 4 ワールド単位/秒 = 0.4m/s）。遅れが無いと
  剛体が振り子のように振れるだけになる。`time.sub(delay)` で評価するだけでよい。
- 動きの速さは目視では詰めきれない。キャンバスを 2D コンテキストに `drawImage` して
  1行分の輝度重心を毎フレーム取れば、実際の振れ幅と周期が数値で出る。
- 息（マイクとスペースキー）と点火状態は React 側が持ち、`CandleIO`（`useRef` の可変オブジェクト）
  を通して毎フレームやりとりする。`setup` は `useMemo` で固定する。
- **息で傾ける量は箱のサイズと対で決める。** レイマーチの箱から炎が出ると、傾けたつもりが
  消えたように見える。傾き（全力で 0.08）+ 炎の半径（0.05）< `BOX_RADIUS`（0.16）に収めること。
- **消灯すると光源がゼロになって画面が真っ暗になる。** 暗順応として
  `renderer.toneMappingExposure` を 0.9 → 2.4 へ 1.5 秒かけて上げている。
  環境光を上げて誤魔化すと、点灯時の見た目まで変わってしまう。
- マイクは必ずボタン押下から `getUserMedia` する。息の音は `noiseSuppression` などの補正で
  消えてしまうので、audio constraints はすべて false にする。
- 輪郭は `taper` が 0 になる高さより上でも `smoothstep` の両端が一致して density が 1 に
  なることがある。**軸上に細い光の筋が伸びたらこれ。** 先端より上を切る項を必ず掛ける。

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

## 公開リポジトリとしての注意

このリポジトリは **public**。そして **git の履歴は消せない**。一度 push したものは、
あとからファイルを消しても履歴から取り出せてしまい、public ではそれがそのまま公開になる。
「入ってから気づく」では手遅れなので、push の前に必ず確認する。

- 個人情報（メールアドレス・電話番号・住所・郵便番号）
- 履歴書・職務経歴書などの個人文書。**そもそもリポジトリに置かない**
- API キー・アクセストークン・秘密鍵
- 20MB を超えるファイル（Cloudflare Pages は 1ファイル 25MB まで。超えるとデプロイが丸ごと落ちる）

[.githooks/pre-push](.githooks/pre-push) がこれらを機械的に検査して push を止める。
**クローン直後は無効なので、一度だけ有効にすること。**

```bash
git config core.hooksPath .githooks
```

検出されても意図した内容なら `git push --no-verify` で通せるが、習慣にしない。

## 既知の制約

- **ローカルの [server.js](server.js) には SPA フォールバックが無い。** パスをそのままファイルパスに
  解決する素朴な静的サーバーなので、`http://localhost:3000/flame` に直接アクセスしたりリロードすると
  404 になる。必ず `/` から画面内のリンクで遷移すること。公開版は `_redirects` があるので直リンクできる。
- `index.html` の `<script src="/dist/bundle.js">` は**絶対パスでなければならない**。相対にすると、
  SPA フォールバック経由で `/flame` を開いたときに `/flame/dist/bundle.js` を探しに行って白画面になる。
  同じ理由で、コード中のアセット参照（`/assets/...` `/images/...`）もすべて絶対パスにしてある。
  **サブパス配信（`example.com/webgpu-sample/` のような形）はこのままでは動かない。**
- `server.js` は拡張子 `.js` のリクエストを自動で `/dist` 配下に振り替える（`index.html` が
  `dist/bundle.js` を読むのはこの仕組みに乗っている）。
- `three` と `three/webgpu` の両方をバンドルしているため、`dist/bundle.js` は 1.8MB ほどある。
- 波動方程式は固定ステップで、フレームレートに依存する（低 fps だと波がゆっくりになる）。
- `index.tsx` は React 18 環境で React 17 の `ReactDOM.render` を使っており、起動時に警告が出る。
- `index.html` は body の `overflow` を塞いでいない（一覧ページがスクロールするため）。
  サンプル側はそれぞれ 100vh の箱の中で完結させること。
- コード・コメント・ログはすべて日本語。既存のスタイルに合わせる。

## 依存関係のバージョン事情

WebGPU/TSL のために three を r185 に上げた際、以下が芋づるで必要になった。下げるときは逆順に注意。

- `three-stdlib` — drei が使っていた（今はどちらも未使用）。2.33 は r185 で削除された
  `LuminanceFormat` を import していてビルドが落ちる。
- `@types/three` — `three/webgpu` と `three/tsl` の型は 0.185 系にしか入っていない。
- `typescript` — 上記の型定義が TS 5 系の構文を使っているため 4.9 では構文エラーになる。
- `tsconfig.json` の `moduleResolution` は `bundler`。`node` のままだと `three/webgpu` を解決できない。
