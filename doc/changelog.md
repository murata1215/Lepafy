# Changelog

## v1.1.0 (2026-06-21) — ドライブ使用率インジケータ

### 新機能
- ツールバーに、開いているフォルダが属するドライブの使用率を表示
  - `💾 D: 1.2TB / 2.0TB (60%)` + ミニプログレスバー
  - 使用率で色分け（<70% 緑 / 70〜90% 黄 / >90% 赤）、ツールチップに空き容量
  - 開く・履歴・セッション復元のいずれの経路でも更新

### 変更詳細
- `main.js`
  - IPC `get-disk-usage` を追加。`fs.promises.statfs()` で容量取得（追加依存なし）
    - `{ total, free, used, usedPercent, driveName }` を返す（free は bavail ベース）
    - driveName は `path.parse(targetPath).root`、失敗時は null
- `preload.js`
  - `getDiskUsage(targetPath)` を contextBridge で公開
- `index.html`
  - `#open-group` 直後に `<span id="disk-usage">` を追加
- `styles.css`
  - `#disk-usage` / `.disk-bar` / `.disk-bar-fill` を追加
  - バー表示の修正: fill に `display:block`（インラインで width/height が無効化される問題）、外枠に暗背景(#1a1a1a)+ボーダーを付与し視認性を改善
- `renderer.js`
  - `formatBytes()`（GB/TB変換）/ `updateDiskUsage()` を追加し buildFolderTree() 末尾で呼ぶ
  - fill の inline style に `!important` を付け CSS 上書きを防止

## v1.1.0 (2026-06-20) — フォルダ履歴機能

### 新機能
- 最近開いたフォルダを履歴として保持し、ドロップダウンから選択して再オープン可能に
  - ツールバー「📂 開く」の横に「▼」ボタンを追加、クリックで履歴一覧を表示
  - 各項目はフォルダ名（最後のディレクトリ名）+ フルパスの2段表示
  - 外側クリック・Escape キーで閉じる、履歴が空のときは「履歴なし」表示

### 変更詳細
- `main.js`
  - `HISTORY_PATH`（`%APPDATA%/lepafy/history.json`）/ `HISTORY_MAX=20` を追加
  - `readFolderHistory()` を追加（非配列・破損ファイルは空配列にフォールバック）
  - IPC `get-folder-history`（履歴配列を返す）を追加
  - IPC `add-folder-history`（重複排除→先頭移動→20件で切り詰め→保存）を追加
    - Windows は大小文字を無視してパス重複を判定
- `preload.js`
  - `getFolderHistory()` / `addFolderHistory(path)` を contextBridge で公開
- `renderer.js`
  - `folderNameFromPath()` ヘルパー（末尾ディレクトリ名を抽出）を追加
  - `openHistoryDropdown()` / `closeHistoryDropdown()` を追加
  - 「📂 開く」選択時・履歴項目クリック時・セッション復元時に `addFolderHistory` を呼ぶ
  - 外側クリック・Escape でドロップダウンを閉じる処理を追加
- `index.html`
  - 「📂 開く」+「▼」+ `#history-dropdown` を `#open-group` でまとめて配置
- `styles.css`
  - ドロップダウン（フロート表示・影付き）と履歴項目（2段表示・ホバー強調）のダークテーマスタイルを追加

## v1.1.0 (2026-06-13) — パフォーマンス改善

### 高速化
- 画像配信を Base64 dataURL → カスタムプロトコル `lepafy-img://lepafy/` に変更
  - メイン側 `protocol.handle` で fs.readFile を直接 Response 返却（Base64エンコード/デコード往復を撤廃）
  - レンダラーは `<img src="lepafy-img://lepafy/...">` でストリーミング受信
  - ホスト部 `lepafy` を明示してWindowsドライブ文字との衝突を回避
- 画像キャッシュを `Map<filePath, HTMLImageElement>` に変更（旧: Base64文字列）
  - `img.decode()` 済みで保持し、表示時は `cloneNode()` で再デコード回避
- 見開きモードの画像ロードを `Promise.all` で2枚並列化（旧: 直列 await）
- 先読み範囲拡張: 前方 10→20 ページ、後方 3→5 ページ、キャッシュ保持 20→40 ページ

### 操作感
- マウスホイール送りを累積デルタ方式に変更
  - `deltaY` を貯めて閾値(100)を超えるごとに1ページ送る
  - 高速回転でも取りこぼし無し（旧: 150ms固定クールダウンで上限あり）
  - 停止判定 200ms、最低間隔 40ms でパイプライン保護
- ファイル一覧の選択更新を差分更新化（毎回全リスト再描画を回避）

### 永続化
- セッション保存をデバウンス（300ms）+ 即時 flush 併用に変更
  - ページ送り中の I/O 過負荷を回避
  - モード変更・ウィンドウ終了時は `flushSession()` で確実に書き出し

### ビルド
- 配布形式をポータブル版単一実行ファイル（約88MB）に集約

## v1.1.0 (2026-05-26)

### 新機能
- 未展開アーカイブの視覚表示: 緑色 + ● マーカーで未読を一目で識別
- NEW バッジ: ファイル更新日が1日以内のアーカイブに赤い「NEW」表示
- 展開済みアーカイブは控えめな灰青色で表示（既読感）
- OSレベルフルスクリーン: ダブルクリックでタイトルバー・タスクバーも非表示
- 画像先読みキャッシュ: 前方10ページ+後方3ページをメモリにプリロード
- electron-builder によるインストーラー・ポータブル版ビルド対応

### 変更
- アプリ名を MViewer → Lepafy に変更
- テストファイル rain.html を削除
- アイコンを Lepafy ロゴに更新

## v1.0.0 (2026-05-24)

### 初回リリース
- 3ペインレイアウト: フォルダツリー / ファイル一覧 / 見開きビューア
- 見開き・単ページモード切替
- 右→左（日本語マンガ）/ 左→右 読み方向切替
- キーボード・マウスホイールによるページ送り
- アーカイブ対応: ZIP / CBZ / RAR / CBR の自動展開
- ネストアーカイブ対応: アーカイブ内アーカイブを再帰展開しツリー表示
- 永続アーカイブキャッシュ（%APPDATA%/lepafy/cache）
- ページ末尾/先頭で兄弟フォルダ・アーカイブへ自動移動
- ダブルクリックでOSレベルフルスクリーン切替
- セッション永続化（前回の閲覧位置・モードを復元）
- ペインリサイズ（ドラッグで左ペイン幅・上下分割比を調整）
- ログ出力（%APPDATA%/lepafy/lepafy.log）
