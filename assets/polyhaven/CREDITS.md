# 外部アセットについて

このディレクトリのファイルは [Poly Haven](https://polyhaven.com/) から取得したものです。

すべて **CC0 1.0 Universal（パブリックドメイン）** で公開されています。
帰属表示は不要、商用利用・改変・再配布いずれも自由です
（[ライセンス原文](https://polyhaven.com/license)）。以下は出典の記録であって、
義務としての帰属表示ではありません。

| ファイル | 元アセット | 使い道 |
|---|---|---|
| `island_tree_02/` | [island_tree_02](https://polyhaven.com/a/island_tree_02) | 木漏れ日の木そのもの。1本 107万三角形（幹27k / 枝330k / 葉715k） |
| `island_tree_02_leaves_alpha_1k.jpg` | 同上 | 葉の抜き。glTF のテクスチャは jpg でアルファを持てないので別途使う |
| `forest_leaves_02_*_1k.jpg` | [forest_leaves_02](https://polyhaven.com/a/forest_leaves_02) | 林床（シームレス） |
| `bark_brown_02_*_1k.jpg` | [bark_brown_02](https://polyhaven.com/a/bark_brown_02) | 樹皮（現在は未使用。木のモデル自身の樹皮を使っている） |
| `tree_stump_01/` | [tree_stump_01](https://polyhaven.com/a/tree_stump_01) | 林床の切り株 |
| `dead_tree_trunk_02/` | [dead_tree_trunk_02](https://polyhaven.com/a/dead_tree_trunk_02) | 林床の倒木 |
| `rock_moss_set_01/` | [rock_moss_set_01](https://polyhaven.com/a/rock_moss_set_01) | 林床の岩／水中の岩（6種） |
| `rock_moss_set_02/` | [rock_moss_set_02](https://polyhaven.com/a/rock_moss_set_02) | 水中の岩（7種） |
| `bark_debris_01/` | [bark_debris_01](https://polyhaven.com/a/bark_debris_01) | 焚き火の薪（4種） |
| `namaqualand_boulders_01/` | [namaqualand_boulders_01](https://polyhaven.com/a/namaqualand_boulders_01) | 焚き火の囲いの石（2種） |

テクスチャはすべて 1k、モデルは glTF の 1k バリアントです。合計およそ 70MB あり、
その大半（46MB）は木のモデルです。実行時に外部へ取りに行くことはありません。

再取得する場合は Poly Haven の API から取れます（User-Agent を付けないと 403 になります）:

```
curl -A "Mozilla/5.0" "https://api.polyhaven.com/files/<asset-id>"
```
