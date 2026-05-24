# Lepafy

ページを軽やかにめくる漫画ビューア。

> *Lepafy = Leaf + Page + -fy*
> "Lepafy your manga collection."

## 機能

- 見開き・単ページモード切替
- 右→左 / 左→右 読み方向切替
- アーカイブ対応（ZIP / CBZ / RAR / CBR）
- ネストアーカイブの再帰展開・ツリー表示
- 画像先読みキャッシュによる高速ページ送り
- ページ末尾で次フォルダへ自動移動
- ダブルクリックでフルスクリーン
- セッション永続化（前回の閲覧位置を復元）

## セットアップ

```bash
npm install
npm start
```

## 技術スタック

- Electron
- node-unrar-js（Wasm）
- yauzl

## ライセンス

MIT
