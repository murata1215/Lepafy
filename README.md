# Lepafy

ページを軽やかにめくる漫画ビューア。

> *Lepafy = Leaf + Page + -fy*
> "Lepafy your manga collection."

## 機能

- 見開き・単ページモード切替
- 右→左 / 左→右 読み方向切替
- フォルダ履歴（最近開いたフォルダを「▼」ドロップダウンから再オープン、最大20件）
- アーカイブ対応（ZIP / CBZ / RAR / CBR）
- ネストアーカイブの再帰展開・ツリー表示
- 未展開アーカイブを緑色 + NEW バッジで視覚表示
- カスタムプロトコル `lepafy-img://` による高速画像配信（Base64非経由）
- 画像先読みキャッシュ（HTMLImageElement、前方20+後方5ページ）
- 累積デルタ方式のホイール送り（高速回転にも追従）
- 見開き並列ロード（Promise.all）
- セッション保存はデバウンス + 終了時 flush
- ページ末尾で次フォルダへ自動移動
- ダブルクリックでフルスクリーン
- セッション永続化（前回の閲覧位置を復元）

## セットアップ

```bash
npm install
npm start
```

## ビルド

ポータブル版（単一実行ファイル、約88MB）のみビルド:

```bash
npx electron-builder --win portable
```

インストーラー(NSIS) + ポータブル版を両方ビルド:

```bash
npm run build
```

成果物は `dist/` に出力されます。

## 技術スタック

- Electron 42
- node-unrar-js v2（Wasm）
- yauzl v3
- electron-builder v26

## ライセンス

MIT
