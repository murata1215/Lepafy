/**
 * プリロードスクリプト
 * メインプロセスとレンダラープロセスの橋渡しを行う
 * contextIsolation: true のもとで安全にAPIを公開する
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** フォルダ選択ダイアログを開く */
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  /** 指定パスのディレクトリ内容を取得する（フォルダ＋アーカイブ） */
  readDir: (dirPath) => ipcRenderer.invoke('read-dir', dirPath),

  /** 指定フォルダ内の画像ファイル一覧を取得する */
  getImages: (dirPath) => ipcRenderer.invoke('get-images', dirPath),

  /**
   * 画像ファイルパスを lepafy-img:// プロトコルのURLに変換する
   * これを <img src> に指定すれば、Base64 dataURLを介さず直接ファイルを読み込める
   * @param {string} filePath - 画像ファイルの絶対パス
   * @returns {string} lepafy-img:// 形式のURL
   */
  imageUrl: (filePath) => {
    /* Windowsパスのバックスラッシュをスラッシュに変換し、特殊文字をエンコードする
       明示的ホスト "lepafy" を含める: standard:true スキーマで空 authority だと
       URL パーサがホスト部に Windows ドライブ文字を取り込む等の誤動作が起きるため */
    const p = filePath.replace(/\\/g, '/');
    return `lepafy-img://lepafy/${encodeURI(p)}`;
  },

  /** 画像配信プロトコルが配信を許可するルートパスをメインプロセスに通知する */
  setRootPath: (rootPath) => ipcRenderer.invoke('set-root-path', rootPath),

  /** アーカイブを展開して展開先パスを返す */
  extractArchive: (archivePath) => ipcRenderer.invoke('extract-archive', archivePath),

  /** 指定パスの兄弟フォルダ・アーカイブ一覧を取得する */
  getSiblings: (itemPath) => ipcRenderer.invoke('get-siblings', itemPath),

  /** ログメッセージをファイルに書き出す */
  writeLog: (message) => ipcRenderer.invoke('write-log', message),

  /** フルスクリーン状態をトグルする（OSレベルのフルスクリーン） */
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),

  /** セッション情報を保存する */
  saveSession: (session) => ipcRenderer.invoke('save-session', session),

  /** 保存済みセッション情報を読み込む */
  loadSession: () => ipcRenderer.invoke('load-session'),

  /** フォルダ履歴（新しい順の配列）を取得する */
  getFolderHistory: () => ipcRenderer.invoke('get-folder-history'),

  /** フォルダ履歴にパスを追加する（重複排除・先頭移動はメイン側で処理） */
  addFolderHistory: (folderPath) => ipcRenderer.invoke('add-folder-history', folderPath),
});
