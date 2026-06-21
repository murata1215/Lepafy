/**
 * Lepafy レンダラープロセス
 * フォルダツリー・ファイル一覧・見開きビューアのUI制御を担当する
 * アーカイブ（ZIP/CBZ/RAR/CBR）をフォルダと同様に扱う
 */

/* ===== 状態管理 ===== */

/** @type {string|null} 現在選択中のルートフォルダパス */
let rootPath = null;

/** @type {Array<{name: string, path: string}>} 現在のフォルダ内の画像ファイル一覧 */
let imageFiles = [];

/** @type {number} 現在表示中のページインデックス（0始まり） */
let currentPage = 0;

/** @type {boolean} 見開き表示モード（true: 2ページ、false: 1ページ） */
let spreadMode = true;

/** @type {boolean} 右→左読み方向（true: 日本語マンガ方向） */
let rtlMode = true;

/** @type {string|null} 現在表示中のフォルダまたはアーカイブの元パス（セッション保存用） */
let currentSourcePath = null;

/** @type {boolean} 現在表示中がアーカイブかどうか（セッション保存用） */
let currentIsArchive = false;

/** @type {boolean} フォルダ間移動処理中かどうか（二重呼び出し防止用） */
let isNavigating = false;

/**
 * @type {Map<string, HTMLImageElement>} 画像先読みキャッシュ
 * 値は img.decode() 済みの HTMLImageElement（表示時はcloneNode）
 * dataURLではなく lepafy-img:// プロトコル経由のURLを src に持つため、
 * V8ヒープを文字列で圧迫せず Chromium の画像キャッシュを直接利用できる
 */
const imageCache = new Map();

/** 先読みするページ数（現在ページの前方） — 高速スクロールに耐えるため拡大 */
const PRELOAD_AHEAD = 20;

/** キャッシュに残すページ数（現在ページの後方） */
const PRELOAD_BEHIND = 5;

/** キャッシュ保持範囲（前後合計、これを超えた分は破棄） */
const CACHE_WINDOW = 40;

/* ===== DOM要素の取得 ===== */
const btnOpen = document.getElementById('btn-open');
const btnOpenHistory = document.getElementById('btn-open-history');
const historyDropdown = document.getElementById('history-dropdown');
const diskUsage = document.getElementById('disk-usage');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const pageInfo = document.getElementById('page-info');
const chkSpread = document.getElementById('chk-spread');
const chkRtl = document.getElementById('chk-rtl');
const folderTree = document.getElementById('folder-tree');
const btnReloadTree = document.getElementById('btn-reload-tree');
const fileList = document.getElementById('file-list');
const viewerContent = document.getElementById('viewer-content');
const pageLeft = document.getElementById('page-left');
const pageRight = document.getElementById('page-right');
const emptyMessage = document.getElementById('empty-message');

/* ===== ツールバーイベント ===== */

/** フォルダを開くボタン */
btnOpen.addEventListener('click', async () => {
  const selected = await window.api.selectFolder();
  if (selected) {
    rootPath = selected;
    await buildFolderTree(selected);
    /* 開いたフォルダを履歴に記録（重複排除・先頭移動はメイン側で処理） */
    await window.api.addFolderHistory(selected);
  }
});

/* ===== フォルダ履歴ドロップダウン ===== */

/**
 * パス文字列からフォルダ名（最後のディレクトリ名）を取り出す
 * レンダラーには path モジュールが無いため区切り文字で分割して末尾を返す
 * @param {string} p - フォルダの絶対パス
 * @returns {string} 末尾のフォルダ名（取得できなければパスそのまま）
 */
function folderNameFromPath(p) {
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/**
 * 履歴ドロップダウンを構築して開く
 * 最新の履歴を取得し、各項目をフォルダ名＋フルパスの2段で描画する
 */
async function openHistoryDropdown() {
  const history = await window.api.getFolderHistory();

  historyDropdown.innerHTML = '';

  if (!history || history.length === 0) {
    /* 履歴が無い場合のメッセージ */
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '履歴なし';
    historyDropdown.appendChild(empty);
  } else {
    for (const folderPath of history) {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.title = folderPath;

      /* 上段: フォルダ名（最後のディレクトリ名） */
      const name = document.createElement('div');
      name.className = 'history-name';
      name.textContent = folderNameFromPath(folderPath);

      /* 下段: フルパス */
      const full = document.createElement('div');
      full.className = 'history-path';
      full.textContent = folderPath;

      item.appendChild(name);
      item.appendChild(full);

      /* クリックでそのフォルダを開く */
      item.addEventListener('click', async () => {
        closeHistoryDropdown();
        rootPath = folderPath;
        await buildFolderTree(folderPath);
        /* 再度開いたので履歴の先頭へ繰り上げる */
        await window.api.addFolderHistory(folderPath);
      });

      historyDropdown.appendChild(item);
    }
  }

  historyDropdown.classList.remove('hidden');
}

/**
 * 履歴ドロップダウンを閉じる
 */
function closeHistoryDropdown() {
  historyDropdown.classList.add('hidden');
}

/** ▼ボタンでドロップダウンの開閉をトグル */
btnOpenHistory.addEventListener('click', (e) => {
  /* 直後の document クリックハンドラに伝播させない（即閉じを防ぐ） */
  e.stopPropagation();
  if (historyDropdown.classList.contains('hidden')) {
    openHistoryDropdown();
  } else {
    closeHistoryDropdown();
  }
});

/* ドロップダウン内クリックは外側クリック扱いにしない */
historyDropdown.addEventListener('click', (e) => e.stopPropagation());

/* 外側クリック・Escapeキーでドロップダウンを閉じる */
document.addEventListener('click', () => closeHistoryDropdown());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHistoryDropdown();
});

/* A: 手動再スキャン（新着確認ボタン） */
btnReloadTree.addEventListener('click', refreshTree);

/* B: ウィンドウ復帰（フォーカス取得）時に自動再スキャン */
let lastFocusRefresh = 0;
window.addEventListener('focus', () => {
  const now = Date.now();
  if (now - lastFocusRefresh < 1000) return;  // 連続発火を抑止
  lastFocusRefresh = now;
  refreshTree();
});

/** 前のページへ戻る */
btnPrev.addEventListener('click', () => navigatePage(-1));

/** 次のページへ進む */
btnNext.addEventListener('click', () => navigatePage(1));

/** 見開きモード切替 */
chkSpread.addEventListener('change', (e) => {
  spreadMode = e.target.checked;
  showPages();
  /* モード変更は明示的な操作なので即時保存（デバウンスを使わない） */
  flushSession();
});

/** 読み方向切替 */
chkRtl.addEventListener('change', (e) => {
  rtlMode = e.target.checked;
  showPages();
  flushSession();
});

/* ===== キーボードナビゲーション ===== */
document.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowLeft':
      /* 右→左モードでは左キーで次ページ（読み進む方向） */
      navigatePage(rtlMode ? 1 : -1);
      e.preventDefault();
      break;
    case 'ArrowRight':
      /* 右→左モードでは右キーで前ページ */
      navigatePage(rtlMode ? -1 : 1);
      e.preventDefault();
      break;
    case 'PageDown':
    case ' ':
      navigatePage(1);
      e.preventDefault();
      break;
    case 'PageUp':
      navigatePage(-1);
      e.preventDefault();
      break;
    case 'Home':
      currentPage = 0;
      showPages();
      e.preventDefault();
      break;
    case 'End':
      currentPage = Math.max(0, imageFiles.length - 1);
      showPages();
      e.preventDefault();
      break;
  }
});

/* ===== フォルダツリー構築 ===== */

/**
 * 指定パスをルートとしてフォルダツリーを構築する
 * @param {string} dirPath - ルートディレクトリのパス
 */
async function buildFolderTree(dirPath) {
  /* 画像配信プロトコルの許可ルートをメインプロセスに通知（パストラバーサル対策） */
  await window.api.setRootPath(dirPath);

  folderTree.innerHTML = '';
  const rootItem = await createTreeItem({
    path: dirPath,
    name: dirPath.split(/[\\/]/).pop(),
    isDirectory: true,
    isArchive: false,
  }, 0, true);
  folderTree.appendChild(rootItem);

  /* ツールバーのドライブ使用率を更新（開く・履歴・セッション復元の全経路がここを通る） */
  await updateDiskUsage(dirPath);
}

/* ===== ドライブ使用率インジケータ ===== */

/**
 * バイト数を人間が読みやすい単位（GB / TB）に変換する
 * 1024 ベースで計算し、小数1桁で丸める。1TB 以上は TB、それ未満は GB 表記。
 * @param {number} bytes - バイト数
 * @returns {string} 例: "1.2TB" / "512.0GB"
 */
function formatBytes(bytes) {
  const GB = 1024 ** 3;
  const TB = 1024 ** 4;
  if (bytes >= TB) {
    return (bytes / TB).toFixed(1) + 'TB';
  }
  return (bytes / GB).toFixed(1) + 'GB';
}

/**
 * 指定フォルダが属するドライブの使用率をツールバーに表示する
 * 取得できなかった場合（null）はインジケータを非表示にする
 * @param {string} folderPath - 対象フォルダの絶対パス
 */
async function updateDiskUsage(folderPath) {
  const usage = await window.api.getDiskUsage(folderPath);

  /* 取得失敗時は隠して終了 */
  if (!usage) {
    diskUsage.classList.add('hidden');
    diskUsage.innerHTML = '';
    return;
  }

  /* 使用率を 0〜100 の整数に丸める */
  const percent = Math.round(usage.usedPercent);

  /* 使用率に応じてバーの色を切り替える（緑 → 黄 → 赤） */
  let barColor;
  if (percent > 90) {
    barColor = '#f44336';       // 90%超: 赤（残量わずか）
  } else if (percent >= 70) {
    barColor = '#ff9800';       // 70〜90%: 黄（注意）
  } else {
    barColor = '#4caf50';       // 70%未満: 緑（余裕あり）
  }

  /* ドライブ名: Windows は "D:\\" 形式で末尾の区切りを除いて "D:" を表示する */
  const driveLabel = usage.driveName
    ? usage.driveName.replace(/[\\/]+$/, '')
    : '';

  /* 💾 ドライブ名 使用量/総量 (使用率%) ミニバー の順で描画
     fill の width/background は inline style に !important を付け、
     CSS 側の指定に確実に勝たせる（色が透明になる問題の保険） */
  diskUsage.innerHTML =
    `<span>💾 ${driveLabel} ${formatBytes(usage.used)} / ${formatBytes(usage.total)} (${percent}%)</span>` +
    `<span class="disk-bar"><span class="disk-bar-fill" style="width:${percent}% !important;background:${barColor} !important;"></span></span>`;

  /* マウスオーバーで空き容量も確認できるようツールチップを付ける */
  diskUsage.title = `空き ${formatBytes(usage.free)} / 全体 ${formatBytes(usage.total)}`;

  diskUsage.classList.remove('hidden');
}

/** @type {boolean} ツリー再スキャン実行中フラグ（多重実行防止） */
let isRefreshingTree = false;

/**
 * フォルダツリーを再スキャンして新着・削除を反映する。
 * 展開状態・選択状態・スクロール位置を保ったまま、読み込み済みフォルダの
 * 直下だけを最新のディレクトリ内容と差分更新する。ビューアには触れない。
 */
async function refreshTree() {
  if (!rootPath || isRefreshingTree) return;
  isRefreshingTree = true;
  btnReloadTree.classList.add('spinning');
  try {
    /* フォルダ行のみ対象（アーカイブ内部は実行中に変化しないため除外） */
    const folderRows = folderTree.querySelectorAll('.tree-item:not(.tree-archive)');
    for (const row of folderRows) {
      if (!row.isConnected) continue;                 // 親reconcileで削除済みはスキップ
      const childrenEl = row.nextElementSibling;
      if (!childrenEl || !childrenEl.classList.contains('tree-children')) continue;
      if (childrenEl.children.length === 0) continue; // 未読み込みフォルダはクリック時に最新化
      await reconcileFolderChildren(row, childrenEl);
    }
  } finally {
    btnReloadTree.classList.remove('spinning');
    isRefreshingTree = false;
  }
}

/**
 * 1フォルダの直下の子を最新ディレクトリ内容に差分更新する。
 * 消えた項目は除去、新着は生成して追加、既存は再利用して並べ替え。
 * @param {HTMLElement} parentRow - 親フォルダ行（.tree-item）
 * @param {HTMLElement} childrenEl - 親フォルダの子コンテナ（.tree-children）
 */
async function reconcileFolderChildren(parentRow, childrenEl) {
  const dirPath = parentRow.dataset.path;
  const parentDepth = Number(parentRow.dataset.depth) || 0;
  const entries = await window.api.readDir(dirPath);   // isCached/mtimeMs も再計算される

  /* 既存の子コンテナを path で引けるよう map 化（snapshot） */
  const existing = new Map();
  for (const container of [...childrenEl.children]) {
    const r = container.querySelector(':scope > .tree-item');
    if (r) existing.set(r.dataset.path, container);
  }
  const entryPaths = new Set(entries.map((e) => e.path));

  /* 消えた項目を除去 */
  for (const [p, container] of existing) {
    if (!entryPaths.has(p)) container.remove();
  }
  /* 最新の並び順で再構築（既存は再利用＝展開状態を保持、新着のみ生成） */
  for (const entry of entries) {
    let container = existing.get(entry.path);
    if (!container) container = await createTreeItem(entry, parentDepth + 1, false);
    childrenEl.appendChild(container);  // 既存ノードは移動するだけ
  }
}

/**
 * ツリーの1項目（フォルダまたはアーカイブ）を生成する
 * @param {Object} entry - エントリ情報 {name, path, isDirectory, isArchive}
 * @param {number} depth - ツリーの深さ（インデント計算用）
 * @param {boolean} expanded - 初期展開状態
 * @returns {HTMLElement} ツリー項目のDOM要素
 */
async function createTreeItem(entry, depth, expanded) {
  const container = document.createElement('div');
  const entryPath = entry.path;
  const isArchive = entry.isArchive;

  /* フォルダ/アーカイブ行 */
  const row = document.createElement('div');
  row.className = 'tree-item';
  if (isArchive) row.classList.add('tree-archive');

  /* 未展開アーカイブにはクラスを付与（展開後に除去） */
  if (isArchive && !entry.isCached) {
    row.classList.add('tree-unread');
  }

  row.dataset.path = entryPath;
  row.style.paddingLeft = (depth * 16 + 6) + 'px';
  row.dataset.depth = String(depth);  // 再スキャン時に子の深さを算出するため保持

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';

  /* アーカイブは展開しないので三角アイコンの代わりに空白 */
  if (isArchive) {
    toggle.textContent = '';
  } else {
    toggle.textContent = expanded ? '▼' : '▶';
  }

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = isArchive ? '📦' : '📁';

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = entry.name;

  row.appendChild(toggle);
  row.appendChild(icon);
  row.appendChild(label);

  /* 最近追加されたアーカイブ（7日以内）に NEW バッジを付ける */
  if (isArchive && entry.mtimeMs) {
    const ageMs = Date.now() - entry.mtimeMs;
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (ageMs < ONE_DAY) {
      const badge = document.createElement('span');
      badge.className = 'tree-new-badge';
      badge.textContent = 'NEW';
      row.appendChild(badge);
    }
  }

  container.appendChild(row);

  if (isArchive) {
    /* アーカイブ用の子要素コンテナ（ネストアーカイブ展開時に使用） */
    const archiveChildren = document.createElement('div');
    archiveChildren.className = 'tree-children';
    container.appendChild(archiveChildren);

    /** @type {boolean} アーカイブを展開済みか */
    let archiveLoaded = false;
    /** @type {string|null} 展開先のキャッシュパス */
    let extractedPath = null;

    /**
     * アーカイブクリック時: 展開してから内容を判定
     * - サブフォルダあり → ツリーに子ノードとして展開
     * - 画像のみ → ファイル一覧に直接表示
     */
    row.addEventListener('click', async () => {
      /* 選択状態のハイライトを更新 */
      document.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));
      row.classList.add('selected');

      if (!archiveLoaded) {
        /* 初回: 展開処理 */
        label.textContent = entry.name + ' (展開中...)';
        icon.textContent = '⏳';

        const result = await window.api.extractArchive(entryPath);

        label.textContent = entry.name;
        icon.textContent = '📦';

        if (result.error) {
          label.textContent = entry.name + ' (エラー)';
          console.error('Archive extraction failed:', result.error);
          return;
        }

        archiveLoaded = true;
        extractedPath = result.extractedPath;

        /* 展開完了: 未読マークを除去 */
        row.classList.remove('tree-unread');

        /* 展開先にサブフォルダがあるか確認 */
        const subEntries = await window.api.readDir(extractedPath);

        if (subEntries.length > 0) {
          /* サブフォルダあり: ツリーに子ノードを追加 */
          toggle.textContent = '▼';
          for (const subEntry of subEntries) {
            const child = await createTreeItem(subEntry, depth + 1, false);
            archiveChildren.appendChild(child);
          }
          archiveChildren.classList.add('open');
        }
      } else {
        /* 2回目以降: 展開/折りたたみ切替 */
        if (archiveChildren.children.length > 0) {
          const isOpen = archiveChildren.classList.toggle('open');
          toggle.textContent = isOpen ? '▼' : '▶';
        }
      }

      /* 展開先フォルダの画像を一覧表示 */
      currentSourcePath = entryPath;
      currentIsArchive = true;
      await loadFileList(extractedPath);
    });
  } else {
    /* 子要素コンテナ（フォルダのみ） */
    const children = document.createElement('div');
    children.className = 'tree-children' + (expanded ? ' open' : '');
    container.appendChild(children);

    /** @type {boolean} 子要素を読み込み済みか */
    let loaded = false;

    /**
     * フォルダクリック時の処理
     * - 該当フォルダの画像ファイルを一覧表示
     * - 初回クリック時にサブフォルダとアーカイブを遅延読み込み
     */
    row.addEventListener('click', async () => {
      /* ファイル一覧を更新 */
      currentSourcePath = entryPath;
      currentIsArchive = false;
      await loadFileList(entryPath);

      /* 選択状態のハイライトを更新 */
      document.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));
      row.classList.add('selected');

      /* サブフォルダ＋アーカイブの遅延読み込み */
      if (!loaded) {
        loaded = true;
        const entries = await window.api.readDir(entryPath);
        for (const childEntry of entries) {
          const child = await createTreeItem(childEntry, depth + 1, false);
          children.appendChild(child);
        }
      }

      /* ツリーの展開/折りたたみ切替 */
      const isOpen = children.classList.toggle('open');
      toggle.textContent = isOpen ? '▼' : '▶';
    });

    /* 初期展開時はサブフォルダ＋アーカイブを読み込む */
    if (expanded) {
      loaded = true;
      const entries = await window.api.readDir(entryPath);
      for (const childEntry of entries) {
        const child = await createTreeItem(childEntry, depth + 1, false);
        children.appendChild(child);
      }
    }
  }

  return container;
}

/* ===== ファイル一覧 ===== */

/**
 * 指定フォルダ内の画像ファイルを一覧表示し、先頭ページを表示する
 * @param {string} dirPath - 対象フォルダのパス
 */
async function loadFileList(dirPath) {
  /* フォルダ切替時は先読みキャッシュをクリア */
  imageCache.clear();

  imageFiles = await window.api.getImages(dirPath);
  currentPage = 0;

  fileList.innerHTML = '';

  if (imageFiles.length === 0) {
    const msg = document.createElement('div');
    msg.style.padding = '10px';
    msg.style.color = '#666';
    msg.textContent = '画像ファイルなし';
    fileList.appendChild(msg);
    clearViewer();
    return;
  }

  imageFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.index = index;

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = '🖼';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;

    item.appendChild(icon);
    item.appendChild(name);

    /* ファイルクリックでそのページに直接ジャンプ */
    item.addEventListener('click', () => {
      currentPage = index;
      showPages();
    });

    fileList.appendChild(item);
  });

  showPages();
}

/* ===== ページ表示 ===== */

/**
 * 現在のページインデックスに基づいてビューアに画像を表示する
 * 見開きモード時は2ページ、単ページモード時は1ページを表示
 */
async function showPages() {
  if (imageFiles.length === 0) {
    clearViewer();
    return;
  }

  emptyMessage.style.display = 'none';

  /* ページ範囲を制限 */
  currentPage = Math.max(0, Math.min(currentPage, imageFiles.length - 1));

  /* ファイル一覧の選択ハイライトを更新 */
  updateFileListSelection();

  if (spreadMode) {
    /* 見開きモード: 2ページ表示（読み込みは並列化して待ち時間を半減） */
    const secondPage = currentPage + 1 < imageFiles.length ? currentPage + 1 : null;
    /* rtlMode によって左右どちらが現在ページかを決める */
    const firstSlot = rtlMode ? pageRight : pageLeft;
    const secondSlot = rtlMode ? pageLeft : pageRight;

    const tasks = [loadPageSlot(firstSlot, imageFiles[currentPage].path)];
    if (secondPage !== null) {
      tasks.push(loadPageSlot(secondSlot, imageFiles[secondPage].path));
    } else {
      secondSlot.innerHTML = '';
    }
    /* 2枚を Promise.all で並列待ち（直列 await より体感が明らかに速い） */
    await Promise.all(tasks);

    /* ページ情報表示 */
    const endPage = secondPage !== null ? secondPage + 1 : currentPage + 1;
    pageInfo.textContent = `${currentPage + 1}-${endPage} / ${imageFiles.length}`;
  } else {
    /* 単ページモード: 1ページのみ表示 */
    pageLeft.innerHTML = '';
    await loadPageSlot(pageRight, imageFiles[currentPage].path);
    pageInfo.textContent = `${currentPage + 1} / ${imageFiles.length}`;
  }

  /* 状態が変わるたびにセッションを保存 */
  saveSession();

  /* 次ページ以降をバックグラウンドで先読み（ノンブロッキング） */
  preloadAhead();
}

/**
 * キャッシュから画像を取得する。キャッシュになければ読み込んでデコードまで済ませる
 * 戻り値の HTMLImageElement は decode 済みなので、cloneNode して DOM に挿入すれば
 * Chromium側で再デコードが走らず瞬時に描画される
 * @param {string} filePath - 画像ファイルのパス
 * @returns {Promise<HTMLImageElement|null>} デコード済み Image、失敗時は null
 */
async function getCachedImage(filePath) {
  const cached = imageCache.get(filePath);
  if (cached) return cached;

  const img = new Image();
  img.src = window.api.imageUrl(filePath);
  try {
    /* デコードを事前に済ませることで、表示時のデコード待ちを排除する */
    await img.decode();
  } catch (err) {
    /* 壊れた画像／プロトコル配信失敗時はキャッシュせず null を返す
       DevTools (Ctrl+Shift+I) でエラー内容を確認できるようコンソールに出す */
    console.error('[Lepafy] image decode failed:', filePath, err);
    return null;
  }
  imageCache.set(filePath, img);
  return img;
}

/**
 * 現在ページの前後を非同期で先読みし、離れたキャッシュを破棄する
 * showPages() からノンブロッキングで呼ばれる
 */
function preloadAhead() {
  /* 先読み範囲: 前方 PRELOAD_AHEAD ページ、後方 PRELOAD_BEHIND ページ */
  const start = Math.max(0, currentPage - PRELOAD_BEHIND);
  const end = Math.min(imageFiles.length, currentPage + PRELOAD_AHEAD + 1);

  /* 1枚ずつ順次読み込み（IPC を詰まらせない） */
  let chain = Promise.resolve();
  for (let i = start; i < end; i++) {
    const fp = imageFiles[i].path;
    if (!imageCache.has(fp)) {
      chain = chain.then(() => getCachedImage(fp));
    }
  }

  /* キャッシュ保持範囲外のエントリを破棄してメモリを節約 */
  chain.then(() => evictDistantCache());
}

/**
 * 現在ページから遠いキャッシュエントリを破棄する
 * CACHE_WINDOW の範囲外にある画像を Map から削除する
 */
function evictDistantCache() {
  const keepStart = Math.max(0, currentPage - CACHE_WINDOW);
  const keepEnd = Math.min(imageFiles.length, currentPage + CACHE_WINDOW + 1);

  /* 保持対象のパスをセットに集める */
  const keepPaths = new Set();
  for (let i = keepStart; i < keepEnd; i++) {
    keepPaths.add(imageFiles[i].path);
  }

  /* セットに含まれないエントリを削除 */
  for (const key of imageCache.keys()) {
    if (!keepPaths.has(key)) {
      imageCache.delete(key);
    }
  }
}

/**
 * 指定のページスロットに画像を読み込んで表示する（キャッシュ優先）
 * デコード済み Image を cloneNode して挿入することで描画が瞬時になる
 * @param {HTMLElement} slot - 表示先のDOM要素
 * @param {string} filePath - 画像ファイルのパス
 */
async function loadPageSlot(slot, filePath) {
  const cached = await getCachedImage(filePath);
  if (cached) {
    /* 同じ Image を複数スロットに置けないため cloneNode する */
    const img = cached.cloneNode();
    img.draggable = false;
    slot.replaceChildren(img);
  }
}

/**
 * ページ送り処理
 * 見開きモードでは2ページずつ、単ページモードでは1ページずつ移動
 * 末尾/先頭を超えた場合は兄弟フォルダ/アーカイブへ自動移動する
 * @param {number} direction - 移動方向（1: 次ページ、-1: 前ページ）
 */
async function navigatePage(direction) {
  if (imageFiles.length === 0) return;

  /* フォルダ間移動処理中は入力を無視（二重呼び出し防止） */
  if (isNavigating) return;

  const step = spreadMode ? 2 : 1;
  const newPage = currentPage + direction * step;

  /* 範囲内ならそのままページ移動 */
  if (newPage >= 0 && newPage < imageFiles.length) {
    currentPage = newPage;
    showPages();
    return;
  }

  /* 範囲外: 兄弟フォルダ/アーカイブへ移動を試みる */
  if (!currentSourcePath) return;

  isNavigating = true;
  try {
    await moveToSibling(direction);
  } finally {
    isNavigating = false;
  }
}

/**
 * パス文字列から親ディレクトリを取得する（レンダラー側で path モジュールが使えないため）
 * @param {string} p - パス文字列
 * @returns {string|null} 親ディレクトリのパス
 */
function getParentPath(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (idx <= 0) return null;
  return p.substring(0, idx);
}

/**
 * 現在のフォルダ/アーカイブの兄弟へ移動する
 * 兄弟が見つからない場合はディレクトリ階層を遡って探す（rootPath まで）
 * direction=1 で次の兄弟（先頭ページ）、direction=-1 で前の兄弟（末尾ページ）
 * @param {number} direction - 移動方向（1: 次、-1: 前）
 */
async function moveToSibling(direction) {
  let searchPath = currentSourcePath;

  /* rootPath まで階層を遡りながら兄弟を探す */
  while (searchPath && searchPath !== rootPath) {
    const siblings = await window.api.getSiblings(searchPath);

    if (siblings.length > 0) {
      const currentIndex = siblings.findIndex((s) => s.path === searchPath);

      if (currentIndex !== -1) {
        let targetIndex = currentIndex + direction;
        while (targetIndex >= 0 && targetIndex < siblings.length) {
          const success = await openSiblingEntry(siblings[targetIndex], direction === -1);
          if (success) {
            window.api.writeLog(`moveToSibling: ${currentSourcePath}`);
            return;
          }
          targetIndex += direction;
        }
      }
    }

    /* この階層では見つからなかったので親へ遡る */
    const parent = getParentPath(searchPath);
    if (!parent || parent.length < rootPath.length) break;
    searchPath = parent;
  }
}

/**
 * 兄弟エントリ（フォルダまたはアーカイブ）を開いて画像を表示する
 * @param {Object} entry - 兄弟エントリ {name, path, isDirectory, isArchive}
 * @param {boolean} goToEnd - true なら末尾ページから表示（前方向への移動時）
 * @returns {Promise<boolean>} 画像が見つかり表示できたら true、スキップすべきなら false
 */
async function openSiblingEntry(entry, goToEnd) {
  /* 兄弟フォルダへの移動時は先読みキャッシュをクリア */
  imageCache.clear();

  let dirPath;
  let sourcePath = entry.path;
  let isArchive = entry.isArchive;

  if (entry.isArchive) {
    const result = await window.api.extractArchive(entry.path);
    if (result.error || !result.extractedPath) return false;
    dirPath = result.extractedPath;
  } else {
    dirPath = entry.path;
  }

  /* 画像一覧を取得 */
  let images = await window.api.getImages(dirPath);

  /* 画像がない場合、サブフォルダのみ1階層探索する（アーカイブ展開はしない・重いため） */
  if (images.length === 0 && !entry.isArchive) {
    const children = await window.api.readDir(dirPath);
    for (const child of children) {
      if (child.isDirectory) {
        images = await window.api.getImages(child.path);
        if (images.length > 0) {
          dirPath = child.path;
          sourcePath = child.path;
          isArchive = false;
          break;
        }
      }
    }
  }

  if (images.length === 0) return false;

  /* 画像があるので状態を更新 */
  currentSourcePath = sourcePath;
  currentIsArchive = isArchive;
  imageFiles = images;

  /* ページ位置を設定（前方向なら末尾、次方向なら先頭） */
  if (goToEnd) {
    currentPage = imageFiles.length - 1;
    /* 見開きモードでは偶数ページに揃える */
    if (spreadMode && currentPage > 0) {
      currentPage = currentPage % 2 === 0 ? currentPage : currentPage - 1;
    }
  } else {
    currentPage = 0;
  }

  /* ファイル一覧UIを再構築 */
  rebuildFileListUI();

  /* ツリーの選択状態を更新 */
  updateTreeSelection(entry.path);

  showPages();
  return true;
}

/**
 * ファイル一覧UIを現在の imageFiles から再構築する
 * loadFileList() はページを0にリセットするため、ページ位置を維持したい場合に使用
 */
function rebuildFileListUI() {
  fileList.innerHTML = '';

  if (imageFiles.length === 0) {
    const msg = document.createElement('div');
    msg.style.padding = '10px';
    msg.style.color = '#666';
    msg.textContent = '画像ファイルなし';
    fileList.appendChild(msg);
    return;
  }

  imageFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.index = index;

    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = '🖼';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;

    item.appendChild(icon);
    item.appendChild(name);

    item.addEventListener('click', () => {
      currentPage = index;
      showPages();
    });

    fileList.appendChild(item);
  });
}

/**
 * フォルダツリー内の指定パスの項目を選択状態にする
 * @param {string} targetPath - 選択したいフォルダ/アーカイブのパス
 */
function updateTreeSelection(targetPath) {
  document.querySelectorAll('.tree-item.selected').forEach((el) => el.classList.remove('selected'));

  /* data-path 属性で検索し、見つかればハイライト */
  const allTreeItems = document.querySelectorAll('.tree-item');
  for (const item of allTreeItems) {
    if (item.dataset.path === targetPath) {
      item.classList.add('selected');
      item.scrollIntoView({ block: 'nearest' });
      break;
    }
  }
}

/**
 * @type {number[]} 直近で selected クラスを付けたファイル項目のインデックス一覧
 * 高速スクロール時、毎回全 .file-item を querySelectorAll/forEach するのを避け、
 * 前回と今回の差分だけを class 操作することで大量ファイル時の負荷を抑える
 */
let lastSelectedIndices = [];

/**
 * ファイル一覧の選択状態を現在のページに合わせて更新する（差分更新版）
 */
function updateFileListSelection() {
  /* 前回ハイライトを外す */
  for (const idx of lastSelectedIndices) {
    const el = fileList.children[idx];
    if (el && el.classList) el.classList.remove('selected');
  }
  /* 今回ハイライトすべきインデックスを算出 */
  const next = spreadMode
    ? (currentPage + 1 < imageFiles.length
        ? [currentPage, currentPage + 1]
        : [currentPage])
    : [currentPage];
  for (const idx of next) {
    const el = fileList.children[idx];
    if (el && el.classList) el.classList.add('selected');
  }
  lastSelectedIndices = next;

  /* 選択されたファイルが見えるようにスクロール（先頭の1件のみ） */
  if (next.length > 0) {
    const el = fileList.children[next[0]];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * ビューアをクリアして初期メッセージを表示する
 */
function clearViewer() {
  pageLeft.innerHTML = '';
  pageRight.innerHTML = '';
  pageInfo.textContent = '-- / --';
  emptyMessage.style.display = 'block';
}

/* ===== ペインリサイズ機能 ===== */

/**
 * 垂直分割バーのドラッグによる左ペイン幅の変更
 */
(function setupMainDivider() {
  const divider = document.getElementById('main-divider');
  const leftPane = document.getElementById('left-pane');

  let isDragging = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    /* 左ペインの幅をマウス位置に合わせる（最小150px） */
    const newWidth = Math.max(150, e.clientX);
    leftPane.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
})();

/**
 * 水平分割バーのドラッグによるフォルダツリー/ファイル一覧の高さ比変更
 */
(function setupLeftDivider() {
  const divider = document.getElementById('left-divider');
  const folderContainer = document.getElementById('folder-tree-container');
  const fileContainer = document.getElementById('file-list-container');
  const leftPane = document.getElementById('left-pane');

  let isDragging = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const paneRect = leftPane.getBoundingClientRect();
    /* ツールバーの高さ(36px)を考慮してマウス位置からフォルダ領域の高さを算出 */
    const offsetY = e.clientY - paneRect.top;
    const totalHeight = paneRect.height;

    /* 最小100pxを確保 */
    const folderHeight = Math.max(100, Math.min(offsetY, totalHeight - 100));
    const fileHeight = totalHeight - folderHeight - 4; /* 4px = divider height */

    folderContainer.style.flex = 'none';
    folderContainer.style.height = folderHeight + 'px';
    fileContainer.style.flex = 'none';
    fileContainer.style.height = fileHeight + 'px';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
})();

/* ===== ダブルクリックでフルスクリーン切替（タイトルバー・タスクバーも非表示） ===== */
document.getElementById('viewer').addEventListener('dblclick', async () => {
  document.body.classList.toggle('fullscreen');
  await window.api.toggleFullscreen();
});

/* ===== マウスホイールでページ送り（累積デルタ方式） ===== */
(function setupWheelNavigation() {
  /**
   * 累積ホイールデルタ方式:
   * deltaY を貯めていき、閾値(WHEEL_THRESHOLD)を超えるごとに1ページ送る。
   * 回転量に追従して連続でページが進むため Leeyes 等のネイティブビューアに近い操作感になる。
   * 最低間隔(WHEEL_MIN_GAP_MS)で連射を抑え、停止後(WHEEL_RESET_MS)に累積をリセットする。
   */

  /** @type {number} ホイール回転量の累積 */
  let accumulatedDelta = 0;

  /** @type {number} 最後にページ送りした時刻 */
  let lastWheelAt = 0;

  /** 1ページ送るのに必要な累積デルタ量（普通のマウスホイール1ノッチ = 100相当） */
  const WHEEL_THRESHOLD = 100;

  /** ホイールが止まったとみなして累積をリセットするまでの時間（ミリ秒） */
  const WHEEL_RESET_MS = 200;

  /** ページ送りの最低間隔（ミリ秒、連射時の描画パイプラインを守るレートリミット） */
  const WHEEL_MIN_GAP_MS = 40;

  document.getElementById('viewer').addEventListener('wheel', (e) => {
    e.preventDefault();

    const now = performance.now();
    /* 一定時間ホイールが停止していたら累積をリセット（逆方向誤発火を防ぐ） */
    if (now - lastWheelAt > WHEEL_RESET_MS) accumulatedDelta = 0;
    accumulatedDelta += e.deltaY;

    /* 閾値を超えるたびにページ送り。1イベントで複数ページ進むこともある */
    while (Math.abs(accumulatedDelta) >= WHEEL_THRESHOLD) {
      if (now - lastWheelAt < WHEEL_MIN_GAP_MS) break;
      const dir = accumulatedDelta > 0 ? 1 : -1;
      accumulatedDelta -= dir * WHEEL_THRESHOLD;
      navigatePage(dir);
      lastWheelAt = now;
    }
  }, { passive: false });
})();

/* ===== セッション保存・復元 ===== */

/** @type {number|null} saveSession デバウンス用タイマーID */
let saveSessionTimer = null;

/** デバウンス時間（ミリ秒） — 高速スクロール時の同期 writeFileSync 連発を防ぐ */
const SAVE_SESSION_DEBOUNCE_MS = 300;

/**
 * セッション保存ペイロードを組み立てる
 * @returns {Object|null} 保存対象、未初期化時は null
 */
function buildSessionPayload() {
  if (!rootPath) return null;
  return {
    rootPath,
    currentSourcePath,
    currentIsArchive,
    currentPage,
    spreadMode,
    rtlMode,
  };
}

/**
 * 現在の閲覧状態をセッションファイルに保存する（デバウンス版）
 * ページ送りのたびに呼んでも、最後の呼び出しから 300ms 経過後に1回だけ書き込む
 */
function saveSession() {
  const payload = buildSessionPayload();
  if (!payload) return;
  if (saveSessionTimer) clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(() => {
    window.api.saveSession(payload);
    saveSessionTimer = null;
  }, SAVE_SESSION_DEBOUNCE_MS);
}

/**
 * 保存待ちのセッションを即座にフラッシュする
 * モード変更時やアプリ終了時に呼び、デバウンス中の書き込みを取りこぼさない
 */
function flushSession() {
  if (saveSessionTimer) {
    clearTimeout(saveSessionTimer);
    saveSessionTimer = null;
  }
  const payload = buildSessionPayload();
  if (!payload) return;
  window.api.saveSession(payload);
}

/* アプリ終了時にデバウンス中の保存を取りこぼさない */
window.addEventListener('beforeunload', flushSession);

/**
 * 前回のセッションを復元する
 * アプリ起動時に自動実行される
 */
async function restoreSession() {
  const session = await window.api.loadSession();
  if (!session || !session.rootPath) return;

  /* 保存されたモード設定を復元 */
  if (typeof session.spreadMode === 'boolean') {
    spreadMode = session.spreadMode;
    chkSpread.checked = spreadMode;
  }
  if (typeof session.rtlMode === 'boolean') {
    rtlMode = session.rtlMode;
    chkRtl.checked = rtlMode;
  }

  /* ルートフォルダのツリーを構築 */
  rootPath = session.rootPath;
  await buildFolderTree(rootPath);
  /* 復元したルートフォルダも履歴に記録（最近使った順を維持） */
  await window.api.addFolderHistory(rootPath);

  /* 前回開いていたフォルダ/アーカイブを復元 */
  if (session.currentSourcePath) {
    currentSourcePath = session.currentSourcePath;
    currentIsArchive = session.currentIsArchive || false;

    if (currentIsArchive) {
      /* アーカイブの場合: 展開してから画像を読み込む */
      const result = await window.api.extractArchive(currentSourcePath);
      if (result.extractedPath) {
        imageFiles = await window.api.getImages(result.extractedPath);
      }
    } else {
      /* フォルダの場合: そのまま画像を読み込む */
      imageFiles = await window.api.getImages(currentSourcePath);
    }

    /* ページ位置を復元 */
    if (typeof session.currentPage === 'number') {
      currentPage = Math.max(0, Math.min(session.currentPage, imageFiles.length - 1));
    }

    /* ファイル一覧UIを構築（loadFileList はページを0にリセットするので rebuildFileListUI を使用） */
    rebuildFileListUI();
    if (imageFiles.length > 0) {
      showPages();
    }
  }
}

/* アプリ起動時にセッションを復元 */
restoreSession();
