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

/** @type {Map<string, string>} 画像先読みキャッシュ（ファイルパス → データURL） */
const imageCache = new Map();

/** 先読みするページ数（現在ページの前方） */
const PRELOAD_AHEAD = 10;

/** キャッシュに残すページ数（現在ページの後方） */
const PRELOAD_BEHIND = 3;

/** キャッシュ保持範囲（前後合計、これを超えた分は破棄） */
const CACHE_WINDOW = 20;

/* ===== DOM要素の取得 ===== */
const btnOpen = document.getElementById('btn-open');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const pageInfo = document.getElementById('page-info');
const chkSpread = document.getElementById('chk-spread');
const chkRtl = document.getElementById('chk-rtl');
const folderTree = document.getElementById('folder-tree');
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
  }
});

/** 前のページへ戻る */
btnPrev.addEventListener('click', () => navigatePage(-1));

/** 次のページへ進む */
btnNext.addEventListener('click', () => navigatePage(1));

/** 見開きモード切替 */
chkSpread.addEventListener('change', (e) => {
  spreadMode = e.target.checked;
  showPages();
  saveSession();
});

/** 読み方向切替 */
chkRtl.addEventListener('change', (e) => {
  rtlMode = e.target.checked;
  showPages();
  saveSession();
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
  folderTree.innerHTML = '';
  const rootItem = await createTreeItem({
    path: dirPath,
    name: dirPath.split(/[\\/]/).pop(),
    isDirectory: true,
    isArchive: false,
  }, 0, true);
  folderTree.appendChild(rootItem);
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
  row.dataset.path = entryPath;
  row.style.paddingLeft = (depth * 16 + 6) + 'px';

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
    /* 見開きモード: 2ページ表示 */
    const secondPage = currentPage + 1 < imageFiles.length ? currentPage + 1 : null;

    if (rtlMode) {
      /* 右→左: 右側に現在ページ、左側に次ページ */
      await loadPageSlot(pageRight, imageFiles[currentPage].path);
      if (secondPage !== null) {
        await loadPageSlot(pageLeft, imageFiles[secondPage].path);
      } else {
        pageLeft.innerHTML = '';
      }
    } else {
      /* 左→右: 左側に現在ページ、右側に次ページ */
      await loadPageSlot(pageLeft, imageFiles[currentPage].path);
      if (secondPage !== null) {
        await loadPageSlot(pageRight, imageFiles[secondPage].path);
      } else {
        pageRight.innerHTML = '';
      }
    }

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
 * キャッシュから画像を取得する。キャッシュになければ読み込んでキャッシュに保存する
 * @param {string} filePath - 画像ファイルのパス
 * @returns {Promise<string|null>} データURL
 */
async function getCachedImage(filePath) {
  if (imageCache.has(filePath)) {
    return imageCache.get(filePath);
  }
  const dataUrl = await window.api.readImage(filePath);
  if (dataUrl) {
    imageCache.set(filePath, dataUrl);
  }
  return dataUrl;
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
 * @param {HTMLElement} slot - 表示先のDOM要素
 * @param {string} filePath - 画像ファイルのパス
 */
async function loadPageSlot(slot, filePath) {
  const dataUrl = await getCachedImage(filePath);
  if (dataUrl) {
    slot.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.draggable = false;
    slot.appendChild(img);
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
 * ファイル一覧の選択状態を現在のページに合わせて更新する
 */
function updateFileListSelection() {
  document.querySelectorAll('.file-item').forEach((el) => {
    const idx = parseInt(el.dataset.index);
    if (spreadMode) {
      /* 見開き時は現在ページと次ページの2つをハイライト */
      el.classList.toggle('selected', idx === currentPage || idx === currentPage + 1);
    } else {
      el.classList.toggle('selected', idx === currentPage);
    }
  });

  /* 選択されたファイルが見えるようにスクロール */
  const selected = document.querySelector('.file-item.selected');
  if (selected) {
    selected.scrollIntoView({ block: 'nearest' });
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

/* ===== マウスホイールでページ送り ===== */
(function setupWheelNavigation() {
  /** @type {number} 最後にホイールでページ送りした時刻（高速スクロール防止用） */
  let lastWheelTime = 0;

  /** 連続スクロール防止のクールダウン（ミリ秒） */
  const WHEEL_COOLDOWN = 150;

  document.getElementById('viewer').addEventListener('wheel', (e) => {
    e.preventDefault();

    const now = Date.now();
    if (now - lastWheelTime < WHEEL_COOLDOWN) return;
    lastWheelTime = now;

    /* deltaY > 0: 下回転（次ページ）、deltaY < 0: 上回転（前ページ） */
    if (e.deltaY > 0) {
      navigatePage(1);
    } else if (e.deltaY < 0) {
      navigatePage(-1);
    }
  }, { passive: false });
})();

/* ===== セッション保存・復元 ===== */

/**
 * 現在の閲覧状態をセッションファイルに保存する
 * ページ送り・フォルダ切替・モード変更のたびに呼ばれる
 */
function saveSession() {
  if (!rootPath) return;

  window.api.saveSession({
    rootPath,
    currentSourcePath,
    currentIsArchive,
    currentPage,
    spreadMode,
    rtlMode,
  });
}

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
