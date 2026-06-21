/**
 * Electron メインプロセス
 * アプリケーションのライフサイクル管理とウィンドウ生成を担当する
 * アーカイブ（ZIP/CBZ/RAR/CBR）の自動展開機能を含む
 */
const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const yauzl = require('yauzl');
const { createExtractorFromFile } = require('node-unrar-js');

/** @type {BrowserWindow|null} メインウィンドウの参照 */
let mainWindow = null;

/** @type {string} アーカイブ展開用の永続キャッシュディレクトリ（%APPDATA%/lepafy/cache） */
const CACHE_BASE = path.join(app.getPath('userData'), 'cache');

/**
 * @type {string|null} 画像配信プロトコルが配信を許可するルートディレクトリ
 * レンダラーから `set-root-path` で通知され、こことCACHE_BASE配下のみ配信する
 */
let allowedRoot = null;

/**
 * lepafy-img:// プロトコルで指定パスを配信してよいか判定する
 * - %APPDATA%/lepafy/cache 配下（アーカイブ展開先）
 * - allowedRoot（ユーザーが開いたルートフォルダ）配下
 * のいずれかに含まれる場合のみ許可する（パストラバーサル対策）
 * @param {string} absPath - 絶対パス（normalize済み想定）
 * @returns {boolean} 配信を許可する場合 true
 */
function isAllowedImagePath(absPath) {
  /* Windowsは大文字小文字を無視するため小文字化して比較する */
  const cmp = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  const cacheNorm = process.platform === 'win32'
    ? path.normalize(CACHE_BASE).toLowerCase()
    : path.normalize(CACHE_BASE);
  if (cmp.startsWith(cacheNorm)) return true;
  if (allowedRoot) {
    const rootNorm = process.platform === 'win32'
      ? path.normalize(allowedRoot).toLowerCase()
      : path.normalize(allowedRoot);
    if (cmp.startsWith(rootNorm)) return true;
  }
  return false;
}

/**
 * 画像ファイルの拡張子から MIME タイプを返す
 * @param {string} filePath - 画像ファイルのパス
 * @returns {string} MIME タイプ
 */
function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * カスタム画像配信プロトコル lepafy-img:// を特権スキーマとして登録する
 * これにより fetch API / streaming / 同一オリジン扱いが有効になり、
 * dataURL を介さずに img.src で直接ファイルを参照できる
 * （app.whenReady() より前に呼ぶ必要がある）
 */
protocol.registerSchemesAsPrivileged([{
  scheme: 'lepafy-img',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    bypassCSP: true,
  },
}]);

/** @type {Set<string>} 対応するアーカイブ拡張子 */
const ARCHIVE_EXTS = new Set(['.zip', '.cbz', '.rar', '.cbr']);

/** @type {Set<string>} 対応する画像拡張子 */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.avif']);

/**
 * メインウィンドウを生成する
 * プリロードスクリプトを介してレンダラープロセスにAPI を公開する
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Lepafy',
    icon: path.join(__dirname, 'icon.png'),
  });

  mainWindow.loadFile('index.html');

  /* メニューバーを非表示にしてビューア領域を最大化 */
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  /* キャッシュディレクトリを作成（既存なら何もしない） */
  fs.mkdirSync(CACHE_BASE, { recursive: true });

  /**
   * lepafy-img:// プロトコルのハンドラを登録
   * URL形式: lepafy-img://lepafy/<encoded-absolute-path>
   *   - 固定ホスト "lepafy" は standard:true スキーマでの URL パース安定化のため
   *   - 旧 Base64 dataURL方式と比べ、IPC文字列転送・Base64エンコード/デコードが
   *     一切走らないため高速スクロール時の体感速度が大幅に向上する
   */
  protocol.handle('lepafy-img', async (request) => {
    try {
      const url = new URL(request.url);
      /* ホスト検証: imageUrl() が生成する "lepafy" 固定ホスト以外は拒否 */
      if (url.host !== 'lepafy') {
        return new Response('Bad host', { status: 400 });
      }
      let filePath = decodeURIComponent(url.pathname);
      /* Windowsの "/C:/Users/..." → "C:/Users/..." 形式に補正 */
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
        filePath = filePath.slice(1);
      }
      const norm = path.normalize(filePath);

      /* 配信許可判定（パストラバーサル対策） */
      if (!isAllowedImagePath(norm)) {
        return new Response('Forbidden', { status: 403 });
      }
      /* fs.promises.readFile で非同期に読み出してそのまま Response として返す */
      const data = await fs.promises.readFile(norm);
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': mimeFromExt(norm),
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      /* 配信失敗はメインプロセスのコンソールに残す（npm start のターミナルで見える） */
      console.error('[lepafy-img] failed:', request.url, err);
      return new Response('Error: ' + err.message, { status: 500 });
    }
  });

  createWindow();
});

/* macOS 以外: 全ウィンドウ閉じたら終了 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* macOS: Dock クリックでウィンドウ再生成 */
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* キャッシュは永続化するため終了時に削除しない */

/**
 * フルスクリーン状態を切り替える（タイトルバー・タスクバーも非表示になる）
 */
ipcMain.handle('toggle-fullscreen', async () => {
  if (!mainWindow) return false;
  const isFullScreen = mainWindow.isFullScreen();
  mainWindow.setFullScreen(!isFullScreen);
  return !isFullScreen;
});

/* ========== ユーティリティ関数 ========== */

/**
 * ファイルパスからアーカイブかどうか判定する
 * @param {string} filePath - 判定対象のファイルパス
 * @returns {boolean} アーカイブファイルなら true
 */
function isArchive(filePath) {
  return ARCHIVE_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * ファイルパスから画像ファイルかどうか判定する
 * @param {string} filePath - 判定対象のファイルパス
 * @returns {boolean} 画像ファイルなら true
 */
function isImage(filePath) {
  return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * アーカイブのキャッシュディレクトリパスを生成する
 * アーカイブのパスとファイルサイズ・更新日時からハッシュを作り、再展開を避ける
 * @param {string} archivePath - アーカイブファイルのパス
 * @returns {string} キャッシュ先ディレクトリのパス
 */
function getCachePath(archivePath) {
  const stat = fs.statSync(archivePath);
  /* パス + サイズ + 更新日時を組み合わせた簡易ハッシュ */
  const key = `${archivePath}|${stat.size}|${stat.mtimeMs}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hashStr = Math.abs(hash).toString(36);
  const baseName = path.basename(archivePath, path.extname(archivePath));
  return path.join(CACHE_BASE, `${baseName}_${hashStr}`);
}

/**
 * ZIP/CBZ ファイルを展開する
 * @param {string} archivePath - アーカイブファイルのパス
 * @param {string} destDir - 展開先ディレクトリ
 * @returns {Promise<void>}
 */
function extractZip(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        /* ディレクトリエントリはスキップ */
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }

        /* 画像ファイルとアーカイブのみ展開（不要なファイルを除外） */
        if (!isImage(entry.fileName) && !isArchive(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        /* サブディレクトリ構造を無視してフラットに展開（ファイル名のみ使用） */
        const outputName = path.basename(entry.fileName);
        const outputPath = path.join(destDir, outputName);

        zipfile.openReadStream(entry, (err2, readStream) => {
          if (err2) return reject(err2);

          const writeStream = fs.createWriteStream(outputPath);
          readStream.pipe(writeStream);
          writeStream.on('finish', () => {
            zipfile.readEntry();
          });
          writeStream.on('error', reject);
        });
      });

      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });
}

/**
 * RAR/CBR ファイルを展開する
 * node-unrar-js（Wasm版）を使用、ネイティブビルド不要
 * @param {string} archivePath - アーカイブファイルのパス
 * @param {string} destDir - 展開先ディレクトリ
 * @returns {Promise<void>}
 */
async function extractRar(archivePath, destDir) {
  const extractor = await createExtractorFromFile({
    filepath: archivePath,
    targetPath: destDir,
    filenameTransform: (name) => path.basename(name),
  });

  /* イテレータを消費して展開を実行（targetPath 指定時はライブラリが直接書き出す） */
  const extracted = extractor.extract();
  for (const file of extracted.files) { /* 展開処理はライブラリ内部で行われる */ }

  /* 画像でもアーカイブでもないファイルを削除 */
  const files = fs.readdirSync(destDir, { withFileTypes: true });
  for (const f of files) {
    if (f.isFile() && !isImage(f.name) && !isArchive(f.name)) {
      fs.unlinkSync(path.join(destDir, f.name));
    }
  }
}

/**
 * 展開先ディレクトリ内のネストされたアーカイブを再帰的に展開する
 * アーカイブをサブディレクトリに展開し、元のアーカイブファイルを削除する
 * @param {string} dirPath - スキャン対象のディレクトリ
 */
async function processNestedArchives(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !isArchive(entry.name)) continue;

    const archiveFilePath = path.join(dirPath, entry.name);
    const subDirName = path.basename(entry.name, path.extname(entry.name));
    const subDirPath = path.join(dirPath, subDirName);

    fs.mkdirSync(subDirPath, { recursive: true });

    const ext = path.extname(entry.name).toLowerCase();
    try {
      if (ext === '.zip' || ext === '.cbz') {
        await extractZip(archiveFilePath, subDirPath);
      } else if (ext === '.rar' || ext === '.cbr') {
        await extractRar(archiveFilePath, subDirPath);
      }

      /* 展開元のアーカイブファイルを削除 */
      fs.unlinkSync(archiveFilePath);

      /* さらにネストがないか再帰チェック */
      await processNestedArchives(subDirPath);
    } catch {
      /* ネスト展開失敗は無視（親アーカイブの展開結果は維持） */
    }
  }
}

/** @type {string} セッション情報の保存先パス */
const SESSION_PATH = path.join(app.getPath('userData'), 'session.json');

/** @type {string} ログファイルのパス */
const LOG_PATH = path.join(app.getPath('userData'), 'lepafy.log');

/** @type {string} フォルダ履歴の保存先パス（%APPDATA%/lepafy/history.json） */
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');

/** @type {number} 履歴として保持する最大件数（これを超えた古いものから削除） */
const HISTORY_MAX = 20;

/**
 * フォルダ履歴を history.json から読み込む
 * ファイルが無い・壊れている場合は空配列を返す
 * @returns {string[]} フォルダパスの配列（新しい順）
 */
function readFolderHistory() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    const data = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(data);
    /* 配列以外（壊れたファイル等）が来ても落とさず空扱いにする */
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ========== IPC ハンドラ（レンダラーからの要求を処理） ========== */

/**
 * ログメッセージをファイルに追記する
 * @param {string} message - ログメッセージ
 */
ipcMain.handle('write-log', async (_event, message) => {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_PATH, `[${timestamp}] ${message}\n`, 'utf8');
  } catch { /* ログ書き込み失敗は無視 */ }
});

/**
 * セッション情報をファイルに保存する
 * ページ位置・表示モード・開いているフォルダ/アーカイブを記録
 * @param {Object} session - 保存するセッション情報
 */
ipcMain.handle('save-session', async (_event, session) => {
  try {
    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
});

/**
 * 保存済みセッション情報を読み込む
 * @returns {Object|null} セッション情報、未保存時は null
 */
ipcMain.handle('load-session', async () => {
  try {
    if (!fs.existsSync(SESSION_PATH)) return null;
    const data = fs.readFileSync(SESSION_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
});

/**
 * フォルダ選択ダイアログを開く
 * @returns {string|null} 選択されたフォルダパス、キャンセル時は null
 */
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

/**
 * 指定パスのディレクトリツリーを取得する（1階層分）
 * フォルダに加えてアーカイブファイルもツリー項目として返す
 * @param {string} dirPath - 対象ディレクトリのパス
 * @returns {Array<{name: string, path: string, isDirectory: boolean, isArchive: boolean, isCached: boolean, mtimeMs: number}>} 子要素の一覧
 */
ipcMain.handle('read-dir', async (_event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => {
        /* 隠しファイル・隠しフォルダを除外 */
        if (e.name.startsWith('.')) return false;
        /* フォルダまたはアーカイブファイルのみ表示 */
        if (e.isDirectory()) return true;
        if (e.isFile() && isArchive(e.name)) return true;
        return false;
      })
      .map((e) => {
        const fullPath = path.join(dirPath, e.name);
        const entryIsArchive = e.isFile() && isArchive(e.name);

        /* アーカイブの場合: キャッシュ済みかどうかと更新日時を取得 */
        let isCached = false;
        let mtimeMs = 0;
        if (entryIsArchive) {
          try {
            const cachePath = getCachePath(fullPath);
            isCached = fs.existsSync(cachePath);
            const stat = fs.statSync(fullPath);
            mtimeMs = stat.mtimeMs;
          } catch { /* 取得失敗時はデフォルト値を使用 */ }
        }

        return {
          name: e.name,
          path: fullPath,
          isDirectory: e.isDirectory(),
          isArchive: entryIsArchive,
          isCached,
          mtimeMs,
        };
      })
      .sort((a, b) => {
        /* フォルダを先、アーカイブを後に並べる */
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        /* 自然順ソート（数字を考慮） */
        return a.name.localeCompare(b.name, 'ja', { numeric: true });
      });
  } catch {
    return [];
  }
});

/**
 * アーカイブを一時ディレクトリに展開し、展開先パスを返す
 * キャッシュ済みの場合は再展開せずキャッシュパスを返す
 * @param {string} archivePath - アーカイブファイルのパス
 * @returns {Promise<{extractedPath: string|null, error: string|null}>}
 */
ipcMain.handle('extract-archive', async (_event, archivePath) => {
  try {
    const cachePath = getCachePath(archivePath);

    /* キャッシュが存在すれば再展開しない */
    if (fs.existsSync(cachePath)) {
      return { extractedPath: cachePath, error: null };
    }

    fs.mkdirSync(cachePath, { recursive: true });

    const ext = path.extname(archivePath).toLowerCase();
    if (ext === '.zip' || ext === '.cbz') {
      await extractZip(archivePath, cachePath);
    } else if (ext === '.rar' || ext === '.cbr') {
      await extractRar(archivePath, cachePath);
    }

    /* ネストされたアーカイブがあれば再帰的に展開 */
    await processNestedArchives(cachePath);

    return { extractedPath: cachePath, error: null };
  } catch (err) {
    return { extractedPath: null, error: err.message };
  }
});

/**
 * 指定フォルダ内の画像ファイル一覧を取得する
 * @param {string} dirPath - 対象ディレクトリのパス
 * @returns {Array<{name: string, path: string}>} 画像ファイルの一覧
 */
ipcMain.handle('get-images', async (_event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => {
        if (!e.isFile()) return false;
        return isImage(e.name);
      })
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  } catch {
    return [];
  }
});

/**
 * 指定パスの兄弟フォルダ・アーカイブ一覧を返す
 * ページ末尾/先頭で次/前のフォルダへ自動移動するために使用
 * @param {string} itemPath - 現在開いているフォルダまたはアーカイブのパス
 * @returns {Array<{name: string, path: string, isDirectory: boolean, isArchive: boolean}>} 兄弟一覧（ソート済み）
 */
ipcMain.handle('get-siblings', async (_event, itemPath) => {
  try {
    const parentDir = path.dirname(itemPath);
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    return entries
      .filter((e) => {
        if (e.name.startsWith('.')) return false;
        if (e.isDirectory()) return true;
        if (e.isFile() && isArchive(e.name)) return true;
        return false;
      })
      .map((e) => ({
        name: e.name,
        path: path.join(parentDir, e.name),
        isDirectory: e.isDirectory(),
        isArchive: e.isFile() && isArchive(e.name),
      }))
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name, 'ja', { numeric: true });
      });
  } catch {
    return [];
  }
});

/**
 * 画像配信プロトコルが配信を許可するルートパスを設定する
 * レンダラーがルートフォルダ選択 or セッション復元の直後に呼び出す
 * @param {string} rootPath - ルートディレクトリ（ユーザーが選択したフォルダ）
 */
ipcMain.handle('set-root-path', async (_event, rootPath) => {
  if (typeof rootPath === 'string' && rootPath.length > 0) {
    allowedRoot = rootPath;
    return true;
  }
  return false;
});

/**
 * フォルダ履歴を取得する
 * @returns {string[]} フォルダパスの配列（新しい順、最大 HISTORY_MAX 件）
 */
ipcMain.handle('get-folder-history', async () => {
  return readFolderHistory();
});

/**
 * 指定パスが属するドライブの使用状況を取得する
 * fs.promises.statfs を使うため追加依存は不要（Node標準API）
 * @param {string} targetPath - 対象フォルダの絶対パス（このパスが乗っているドライブを調べる）
 * @returns {Promise<{total: number, free: number, used: number, usedPercent: number, driveName: string}|null>}
 *   - total: ドライブ総容量（バイト）
 *   - free: 空き容量（バイト、一般ユーザーが使える量 = bavail ベース）
 *   - used: 使用容量（バイト = total - free）
 *   - usedPercent: 使用率（0〜100 の数値）
 *   - driveName: ドライブ名（Windows なら "D:\" 形式のルート）
 *   取得失敗時は null
 */
ipcMain.handle('get-disk-usage', async (_event, targetPath) => {
  /* 不正な引数は早期に null を返す */
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return null;
  }

  try {
    /* statfs はファイルシステムの統計情報を返す:
       - bsize:  ブロックサイズ（バイト）
       - blocks: 総ブロック数
       - bfree:  空きブロック数（管理領域含む）
       - bavail: 非特権ユーザーが使える空きブロック数（実用的な空き容量） */
    const stats = await fs.promises.statfs(targetPath);

    const blockSize = stats.bsize;
    const total = stats.blocks * blockSize;
    /* 実際にユーザーが使える空き容量として bavail を採用する */
    const free = stats.bavail * blockSize;
    const used = total - free;

    /* 使用率（0除算を避けつつ 0〜100 に丸める） */
    const usedPercent = total > 0 ? (used / total) * 100 : 0;

    /* ドライブ名: Windows は "D:\\" 形式のルートを使う。
       path.parse(...).root は targetPath が属するドライブのルートを返す */
    const driveName = path.parse(targetPath).root;

    return { total, free, used, usedPercent, driveName };
  } catch {
    /* 存在しないパス・アクセス不可などは null（呼び出し側で非表示にする） */
    return null;
  }
});

/**
 * フォルダ履歴にパスを追加して保存する
 * - 重複パスは追加せず既存エントリを先頭へ移動する（最近使った順を維持）
 * - 最大 HISTORY_MAX 件を超えた古いエントリは末尾から削除する
 * @param {string} folderPath - 追加するフォルダの絶対パス
 * @returns {string[]} 更新後の履歴配列（新しい順）
 */
ipcMain.handle('add-folder-history', async (_event, folderPath) => {
  /* 不正な値は無視して現状の履歴を返す */
  if (typeof folderPath !== 'string' || folderPath.length === 0) {
    return readFolderHistory();
  }

  let history = readFolderHistory();

  /* 既存の同一パスを除去（重複排除）。Windowsは大小文字無視で比較する */
  const samePath = (a, b) =>
    process.platform === 'win32'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  history = history.filter((p) => !samePath(p, folderPath));

  /* 先頭へ追加（＝最近使った順の先頭に来る） */
  history.unshift(folderPath);

  /* 最大件数を超えた分を末尾から切り詰める */
  if (history.length > HISTORY_MAX) {
    history = history.slice(0, HISTORY_MAX);
  }

  /* ファイルへ保存（失敗しても落とさない） */
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
  } catch { /* 履歴書き込み失敗は無視 */ }

  return history;
});
