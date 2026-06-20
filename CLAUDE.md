<!-- DevRelay Agreement v6 -->
See `rules/devrelay.md` for DevRelay rules.
<!-- /DevRelay Agreement -->

---

# Lepafy

## 技術スタック
- Electron (v42)
- node-unrar-js v2 (Wasm) — RAR/CBR展開
- yauzl v3 — ZIP/CBZ展開
- electron-builder v26 — ポータブル版.exeビルド
- カスタムプロトコル `lepafy-img://lepafy/` — 画像配信（Base64非経由）

## プロジェクト構成
- `main.js` — メインプロセス（IPC、アーカイブ展開、キャッシュ管理）
- `preload.js` — contextBridge でレンダラーにAPI公開
- `renderer.js` — UI制御（ツリー、ファイル一覧、ビューア、先読みキャッシュ）
- `index.html` — 3ペインレイアウト
- `styles.css` — ダークテーマUI

## ルール
- ソースコードには詳細な日本語コメントを必ず残す
- 設計判断は `rules/project.md` に記録
