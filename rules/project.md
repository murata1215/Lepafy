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

## アーカイブ表示状態
- read-dir がアーカイブに isCached (キャッシュ有無) と mtimeMs (更新日時) を付与
- 未展開: 緑色(#5ef0b0) + ● マーカー + 太字 → 展開後に除去
- NEW バッジ: 更新日が1日以内のアーカイブに赤い「NEW」表示
- 展開済み: 控えめな灰青(#6a8ea0)

## ページ表示
- 画像配信: カスタムプロトコル `lepafy-img://` 経由（Base64 dataURL は廃止）
  - メイン側 `protocol.handle('lepafy-img', ...)` で fs.promises.readFile してそのまま Response 返却
  - allowedRoot（ユーザー選択ルート）と CACHE_BASE 配下のみ配信（パストラバーサル対策）
  - レンダラーは `window.api.imageUrl(path)` で `lepafy-img://lepafy/<encoded-path>` を生成
  - ホスト部に明示 `lepafy` を指定（空 authority だと Chromium URL パーサが Windows ドライブ文字 `C:` をホスト:ポートと誤認するため）
- 画像先読みキャッシュ: Map<filePath, HTMLImageElement>、img.decode() 済みで保持
  - 前方20ページ+後方5ページをプリロード、キャッシュ保持範囲は前後40ページ
- 表示はキャッシュ済み Image を cloneNode して挿入（再デコードを回避）
- 見開きモードは Promise.all で2枚並列読み込み（直列 await は廃止）
- フォルダ切替時にキャッシュをクリア

## フルスクリーン
- ダブルクリックでCSS class切替 + Electron setFullScreen() を併用
- タイトルバー・タスクバーも非表示にするOSレベルフルスクリーン

## フォルダ間移動
- moveToSibling: rootPathまで階層を遡って兄弟を探す
- isNavigating ロックで二重呼び出し防止
- サブフォルダ探索はするがアーカイブ展開はしない（重いため）

## ホイール送り
- 累積デルタ方式: deltaY を貯めて閾値(WHEEL_THRESHOLD=100)を超えるごとに1ページ送る
- 停止判定 200ms、最低間隔 40ms（高速回転時の連射上限とパイプライン保護）
- 旧クールダウン方式(150ms固定)は廃止

## セッション保存
- ページ送りは saveSession() でデバウンス(300ms)
- モード変更・終了(beforeunload)時は flushSession() で即時書き込み

## フォルダ履歴
- %APPDATA%/lepafy/history.json に最近開いたフォルダパスを新しい順で保存（最大20件）
- 重複パスは追加せず既存を先頭へ繰り上げ（Windowsは大小文字無視で比較）
- 記録タイミング: 「開く」ダイアログ選択時 / 履歴から選択時 / セッション復元時
- IPC: get-folder-history（配列取得）/ add-folder-history（追加・先頭移動・切り詰め）
- UI: ツールバー「📂 開く」横の「▼」でドロップダウン表示、項目はフォルダ名+フルパスの2段
  - 外側クリック・Escapeで閉じる、空時は「履歴なし」

## ドライブ使用率インジケータ
- ツールバー「📂 開く」群の右側に、開いているフォルダが属するドライブの使用率を表示
- IPC `get-disk-usage`: `fs.promises.statfs(targetPath)` で取得（追加依存なし・クロスプラットフォーム）
  - 戻り値 `{ total, free, used, usedPercent, driveName }`（容量はバイト、free は bavail ベース）
  - driveName は `path.parse(targetPath).root`（例: `D:\`）、取得失敗時は null
- 表示: `💾 D: 使用量/総量 (使用率%)` + ミニプログレスバー
  - 使用率で色分け: <70% 緑(#4caf50) / 70〜90% 黄(#ff9800) / >90% 赤(#f44336)
  - fill は `display:block` 必須（span はインラインだと width/height が無視される）
  - inline style に `!important` を付け CSS 上書きを防止、`.disk-bar` は暗背景+ボーダーで視認性確保
- 更新タイミング: buildFolderTree() 末尾（開く・履歴・セッション復元の全経路をカバー）

## ビルド・配布
- electron-builder でインストーラー(NSIS) + ポータブル版を生成
- 出力先: dist/
