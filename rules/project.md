# プロジェクト固有ルール

## アーキテクチャ
- Electron (contextIsolation: true, nodeIntegration: false)
- IPC通信: ipcMain.handle / ipcRenderer.invoke + preload bridge
- ソースコードには詳細な日本語コメントを必ず残す

## アーカイブ処理
- ZIP/CBZ: yauzl で展開
- RAR/CBR: node-unrar-js (Wasm版、targetPath + filenameTransform)
- キャッシュ: %APPDATA%/lepafy/cache にパス+サイズ+更新日時のハッシュで永続化
- ネストアーカイブ: processNestedArchives() で再帰展開

## ページ表示
- 画像先読みキャッシュ: Map<filePath, dataURL>、前方10ページ+後方3ページをプリロード
- キャッシュ保持範囲: 現在ページ前後20ページ、超過分は自動破棄
- フォルダ切替時にキャッシュをクリア

## フルスクリーン
- ダブルクリックでCSS class切替 + Electron setFullScreen() を併用
- タイトルバー・タスクバーも非表示にするOSレベルフルスクリーン

## フォルダ間移動
- moveToSibling: rootPathまで階層を遡って兄弟を探す
- isNavigating ロックで二重呼び出し防止
- サブフォルダ探索はするがアーカイブ展開はしない（重いため）
