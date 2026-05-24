/**
 * Electron メインプロセス
 * アプリケーションのライフサイクル管理とウィンドウ生成を担当する
 * アーカイブ（ZIP/CBZ/RAR/CBR）の自動展開機能を含む
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const yauzl = require('yauzl');
const { createExtractorFromFile } = require('node-unrar-js');

/** @type {BrowserWindow|null} メインウィンドウの参照 */
let mainWindow = null;

/** @type {string} アーカイブ展開用の永続キャッシュディレクトリ（%APPDATA%/lepafy/cache） */
const CACHE_BASE = path.join(app.getPath('userData'), 'cache');

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
 * @returns {Array<{name: string, path: string, isDirectory: boolean, isArchive: boolean}>} 子要素の一覧
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
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
        isArchive: e.isFile() && isArchive(e.name),
      }))
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
 * ファイルパスから画像データを Base64 で読み込む
 * セキュリティ上、file:// プロトコルを使わず Base64 データURLで渡す
 * @param {string} filePath - 画像ファイルのパス
 * @returns {string} data URL 形式の画像データ
 */
ipcMain.handle('read-image', async (_event, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.bmp': 'image/bmp',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
    };
    const mime = mimeMap[ext] || 'image/jpeg';
    const data = fs.readFileSync(filePath);
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
});
