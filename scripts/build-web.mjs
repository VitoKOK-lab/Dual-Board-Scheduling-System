#!/usr/bin/env node
/**
 * 把伺服器版打包成單一 HTML，可直接放上靜態主機或 Artifact。
 *
 * 領域邏輯（src/domain）原封不動沿用——排班引擎、公平性、Plan X
 * 本來就是純函式，不碰資料庫。只有資料層換掉：
 *   src/db + src/services  →  web/store.js + web/services.js
 *   src/server（REST API） →  web/dispatch.js（同樣的路徑與回傳格式）
 * 因此 public/app.js 幾乎原樣搬過去，只做幾處必要修補。
 *
 *   node scripts/build-web.mjs  →  web/dual-board.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

/** 去掉 ESM 語法，讓所有檔案能併進同一個 IIFE。 */
const stripModule = (src) => src
  .replace(/^import[^;]*;\s*$/gm, '')
  .replace(/^export /gm, '')
  .trim();

const DOMAIN_FILES = ['constants.js', 'week.js', 'fairness.js', 'scheduler.js', 'planX.js'];
const domain = DOMAIN_FILES
  .map((f) => `/* ===== src/domain/${f} ===== */\n${stripModule(read('src', 'domain', f))}`)
  .join('\n\n');

/** 對 public/app.js 的必要修補，每一處都必須命中，否則直接失敗。 */
const PATCHES = [
  {
    why: '領域層已提供同名常數，移除重複宣告',
    from: `const WHITEBOARD_SHIFTS = ['MORNING', 'FLAG', 'NOON'];\nconst SHIFT_LABEL = { MORNING: '早修', FLAG: '升旗', NOON: '午休' };\n`,
    to: '',
  },
  {
    why: '空狀態要能區分「沒排班」與「還沒設定點位／師傅」',
    from: `  wrap.append(icon('i-bolt'));\n  wrap.append(el('h3', null, '本週尚未排班'));`,
    to: `  const noItems = state.data.items.length === 0;
  const noMasters = (state.data.capacity?.masters ?? 0) === 0;

  if (noItems || noMasters) {
    wrap.append(icon('i-settings'));
    wrap.append(el('h3', null, '先設定點位與成員'));
    wrap.append(el('p', null, noItems
      ? '還沒有任何點位。點右上角的齒輪新增點位與成員，再回來排班。'
      : '還沒有可排班的師傅。點右上角的齒輪新增師傅，或把徒弟升級。'));
    const go = el('button', 'btn btn--primary');
    go.type = 'button';
    go.append(icon('i-settings'), el('span', null, '打開設定'));
    go.addEventListener('click', openSettings);
    wrap.append(go);
    return wrap;
  }

  wrap.append(icon('i-bolt'));
  wrap.append(el('h3', null, '本週尚未排班'));`,
  },
  {
    why: '開機先連上儲存層',
    from: `  bindChrome();\n  try {\n    await loadWeek(todayIso());`,
    to: `  bindChrome();\n  try {\n    const { synced } = await initStore();\n    state.synced = synced;\n    await loadWeek(todayIso());`,
  },
  {
    why: '開機結束一定要收掉載入遮罩',
    from: `  } catch (error) {\n    toast(error.message, 'error');\n  }\n}`,
    to: `  } catch (error) {\n    toast(error.message, 'error');\n  } finally {\n    $('#loading').hidden = true;\n  }\n}`,
  },
  {
    why: '設定面板標明資料存在雲端還是只在這台裝置',
    from: `  if (adminTab === 'items') renderItemAdmin(body);`,
    to: `  const where = el('p', 'field__hint');
  where.textContent = state.synced
    ? '資料存在這個頁面的雲端儲存，換裝置打開同一個網址就看得到。'
    : '目前只存在這台裝置的瀏覽器裡，換裝置看不到。';
  body.append(where);

  if (adminTab === 'items') renderItemAdmin(body);`,
  },
];

let app = read('public', 'app.js');
for (const { why, from, to } of PATCHES) {
  if (!app.includes(from)) throw new Error(`修補失敗（${why}）：在 public/app.js 找不到對應片段`);
  app = app.replace(from, to);
}

// fetch 版的 api() 換成 web/dispatch.js 的本機版本
const apiStart = app.indexOf('/* ---------- API ---------- */');
const apiEnd = app.indexOf('let toastTimer;');
if (apiStart < 0 || apiEnd < 0) throw new Error('修補失敗：找不到 public/app.js 的 API 區塊');
app = `${app.slice(0, apiStart)}/* ---------- 提示 ---------- */\n\n${app.slice(apiEnd)}`;

const html = read('public', 'index.html');
const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script src="./app.js"')).trim();

const script = [domain, read('web', 'store.js'), read('web', 'services.js'), read('web', 'dispatch.js'), app].join('\n\n');

const out = `<title>雙板排班</title>
<meta name="description" content="數位化實體黑板與白板的排班看板：一鍵自動排班、公平輪替、Plan B 雙層備援。">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Space+Mono:wght@400;700&display=swap">
<style>
${read('public', 'styles.css')}
</style>

${body}

<script>
(function () {
'use strict';
${script}
}())
</script>
`;

const target = join(ROOT, 'web', 'dual-board.html');
writeFileSync(target, out);
console.log(`已產生 ${target}（${(Buffer.byteLength(out) / 1024).toFixed(0)} KB）`);
