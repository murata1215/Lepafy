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

  /** 画像ファイルを Base64 データURLとして読み込む */
  readImage: (filePath) => ipcRenderer.invoke('read-image', filePath),

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
});
