import {
  collectFromDataTransfer,
  filesFromInput,
  inspectPhotoFile,
  isImageFile,
  pickFilesWithFs,
  pickFolderWithFs,
  revealPhoto,
  revokePhoto,
  shuffle,
  supportsDirPicker,
  supportsFsAccess,
} from "./files.js";
import { captureThumb, createPhotoViewer, disposeThumbEngine, thumbPlaceholder } from "./viewer.js";
import {
  CATEGORIES,
  CATEGORY_KEYS,
  categorySlug,
  emptyRatings,
  pluralCategories,
} from "./categories.js";

// Минимальное значение фильтра по категории (0 = «любое»).
function zeroFilters() {
  return emptyRatings(0);
}

const state = {
  photos: [],
  rejected: [],
  skipped: 0,
  order: [],
  index: 0,
  screen: "upload",
  sortKey: "total",
  // Результат тейбрейкера: Map(photoId -> rank внутри группы ничьих), либо null,
  // если тейбрейкер ещё не проводился (или был сброшен после изменения оценок).
  tiebreak: null,
  // Признак того, что данные загружены из JSON, а не оценены в этой сессии.
  imported: false,
  filters: {
    query: "",
    minScore: null,
    maxScore: null,
    min: zeroFilters(),
  },
};

const els = {
  screens: {
    upload: document.getElementById("screen-upload"),
    rate: document.getElementById("screen-rate"),
    board: document.getElementById("screen-board"),
    tiebreak: document.getElementById("screen-tiebreak"),
  },
  dropzone: document.getElementById("dropzone"),
  summary: document.getElementById("upload-summary"),
  validCount: document.getElementById("valid-count"),
  skipCount: document.getElementById("skip-count"),
  validList: document.getElementById("valid-list"),
  invalidBlock: document.getElementById("invalid-block"),
  invalidList: document.getElementById("invalid-list"),
  btnStart: document.getElementById("btn-start"),
  btnClearAll: document.getElementById("btn-clear-all"),
  btnClearInvalid: document.getElementById("btn-clear-invalid"),
  btnPickFiles: document.getElementById("btn-pick-files"),
  btnPickFolder: document.getElementById("btn-pick-folder"),
  btnImport: document.getElementById("btn-import"),
  inputFiles: document.getElementById("input-files"),
  inputFolder: document.getElementById("input-folder"),
  inputImport: document.getElementById("input-import"),
  currentName: document.getElementById("current-name"),
  rateStage: document.getElementById("rate-stage"),
  rateProgress: document.getElementById("rate-progress"),
  categories: document.getElementById("categories"),
  totalValue: document.getElementById("total-value"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  btnSkip: document.getElementById("btn-skip"),
  btnZoomIn: document.getElementById("btn-zoom-in"),
  btnZoomOut: document.getElementById("btn-zoom-out"),
  btnZoomFit: document.getElementById("btn-zoom-fit"),
  zoomLevel: document.getElementById("zoom-level"),
  topbarMeta: document.getElementById("topbar-meta"),
  podium: document.getElementById("podium"),
  lbBody: document.getElementById("lb-body"),
  toast: document.getElementById("toast"),
  dialog: document.getElementById("reveal-dialog"),
  revealPath: document.getElementById("reveal-path"),
  revealDir: document.getElementById("reveal-dir"),
  btnCopyPath: document.getElementById("btn-copy-path"),
  btnCopyDir: document.getElementById("btn-copy-dir"),
  boardSort: document.getElementById("board-sort"),
  toggleFilters: document.getElementById("btn-toggle-filters"),
  boardFilters: document.getElementById("board-filters"),
  btnExport: document.getElementById("btn-export"),
  btnBackRate: document.getElementById("btn-back-rate"),
  btnNewSession: document.getElementById("btn-new-session"),
  boardSearch: document.getElementById("board-search"),
  boardMinScore: document.getElementById("board-min-score"),
  boardMaxScore: document.getElementById("board-max-score"),
  // Селекты «минимум по категории» строятся динамически из CATEGORIES.
  categoryFilters: document.getElementById("category-filters"),
  lbHead: document.getElementById("lb-head"),
  rateKickerCats: document.getElementById("rate-kicker-cats"),
  btnResetFilters: document.getElementById("btn-reset-filters"),
  // Tiebreaker
  tiebreakInfo: document.getElementById("tiebreak-info"),
  tiebreakLeft: document.getElementById("tiebreak-left"),
  tiebreakRight: document.getElementById("tiebreak-right"),
  btnTiebreakSkip: document.getElementById("btn-tiebreak-skip"),
  // Import
  importDialog: document.getElementById("import-dialog"),
  importPreview: document.getElementById("import-preview"),
  btnImportConfirm: document.getElementById("btn-import-confirm"),
  // Detail viewer
  detailDialog: document.getElementById("detail-dialog"),
  detailStage: document.getElementById("detail-stage"),
  detailPlaceholder: document.getElementById("detail-placeholder"),
  detailName: document.getElementById("detail-name"),
  detailScore: document.getElementById("detail-score"),
  detailCategories: document.getElementById("detail-categories"),
};

let rateHandle = null;
// key категории -> select фильтра «минимум по категории».
const categoryFilterSelects = new Map();
let toastTimer = 0;
let detailHandle = null;
let detailPhoto = null;
let detailRenderToken = 0;

// Tiebreaker: два переиспользуемых вьюера (левый/правый) на весь экран тейбрейкера,
// освобождаются после разрешения всех ничьих.
const tiebreakHandles = [];
let tiebreakChoiceResolve = null;
let tiebreakAborted = false;
let tiebreakCompareCount = 0;
let tiebreakGroupLabel = "";
let pendingImport = null;

function currentPhoto() {
  const id = state.order[state.index];
  return state.photos.find((p) => p.id === id) || null;
}

function average(ratings) {
  const values = CATEGORIES.map((c) => ratings[c.key]);
  if (values.some((v) => v == null)) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function formatScore(score) {
  if (score == null) return "—/10";
  return `${score.toFixed(1)}/10`;
}

function showToast(text) {
  els.toast.hidden = false;
  els.toast.textContent = text;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

function setScreen(name) {
  state.screen = name;
  for (const [key, node] of Object.entries(els.screens)) {
    const active = key === name;
    node.hidden = !active;
    node.classList.toggle("is-active", active);
  }
  if (name === "upload") els.topbarMeta.textContent = "Загрузка фото";
}

function pluralPhotos(n) {
  // «Фото» — несгибаемое: 1 фото, 2 фото, 5 фото.
  return `${n} фото`;
}

function renderUpload() {
  const hasAny = state.photos.length || state.rejected.length;
  els.summary.hidden = !hasAny;
  els.validCount.textContent = `Найдено ${pluralPhotos(state.photos.length)}`;
  const extra = [];
  if (state.skipped) extra.push(`пропущено файлов: ${state.skipped}`);
  if (state.rejected.length) extra.push(`ошибочных: ${state.rejected.length}`);
  els.skipCount.textContent = extra.join(" · ");

  els.validList.replaceChildren(
    ...state.photos.map((photo) => {
      const chip = document.createElement("div");
      chip.className = "chip";

      const thumb = document.createElement("img");
      thumb.className = "chip-thumb";
      thumb.src = photo.url;
      thumb.alt = "";
      thumb.decoding = "async";

      const label = document.createElement("span");
      label.textContent = photo.name;
      label.title = photo.relativePath;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", "Убрать");
      remove.textContent = "×";
      remove.addEventListener("click", () => removePhoto(photo.id));

      chip.append(thumb, label, remove);
      return chip;
    }),
  );

  els.invalidBlock.hidden = state.rejected.length === 0;
  els.invalidList.replaceChildren(
    ...state.rejected.map((item, idx) => {
      const li = document.createElement("li");
      li.className = "invalid-item";
      li.innerHTML = `<div><b></b><br><small></small></div><button type="button" class="btn btn-text">Убрать</button>`;
      li.querySelector("b").textContent = item.name;
      li.querySelector("small").textContent = item.reason;
      li.querySelector("button").addEventListener("click", () => {
        state.rejected.splice(idx, 1);
        renderUpload();
      });
      return li;
    }),
  );

  els.btnStart.disabled = state.photos.length === 0;
}

function escapeAttr(value) {
  return String(value).replace(/"/g, "&quot;");
}

function removePhoto(id) {
  const idx = state.photos.findIndex((p) => p.id === id);
  if (idx === -1) return;
  revokePhoto(state.photos[idx]);
  state.photos.splice(idx, 1);
  renderUpload();
}

function clearAll() {
  state.photos.forEach(revokePhoto);
  state.photos = [];
  state.rejected = [];
  state.skipped = 0;
  renderUpload();
}

async function ingestEntries(entries) {
  if (!entries.length) {
    showToast("Файлы не выбраны");
    return;
  }

  let added = 0;
  for (const entry of entries) {
    if (entry.file && !isImageFile(entry.file)) {
      state.skipped += 1;
      continue;
    }
    const result = await inspectPhotoFile(entry);
    if (result.ok) {
      const dup = state.photos.some(
        (p) => p.relativePath === result.photo.relativePath && p.file.size === result.photo.file.size,
      );
      if (dup) {
        revokePhoto(result.photo);
        continue;
      }
      state.photos.push(result.photo);
      added += 1;
    } else {
      state.rejected.push(result);
    }
  }

  renderUpload();
  if (added) showToast(`Добавлено фото: ${added}`);
}

function buildCategories() {
  els.categories.replaceChildren(
    ...CATEGORIES.map((cat) => {
      const card = document.createElement("div");
      card.className = "cat";
      card.dataset.key = cat.key;
      card.innerHTML = `
        <div class="cat-top">
          <div class="cat-name"><i class="swatch"></i>${cat.label}</div>
          <div class="cat-val" data-val>—</div>
        </div>
        <div class="stars" role="radiogroup" aria-label="${cat.label}"></div>
      `;
      const row = card.querySelector(".stars");
      for (let i = 1; i <= 10; i += 1) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "star";
        btn.dataset.v = String(i);
        btn.setAttribute("aria-label", `${cat.label}: ${i}`);
        row.append(btn);
      }

      row.addEventListener("pointermove", (event) => {
        const btn = event.target.closest(".star");
        if (!btn) return;
        paintStars(row, Number(btn.dataset.v), true);
      });
      row.addEventListener("pointerleave", () => {
        const photo = currentPhoto();
        paintStars(row, photo?.ratings[cat.key], false);
      });
      row.addEventListener("click", (event) => {
        const btn = event.target.closest(".star");
        if (!btn) return;
        const photo = currentPhoto();
        if (!photo) return;
        photo.ratings[cat.key] = Number(btn.dataset.v);
        photo.skipped = false;
        invalidateTiebreak();
        refreshRatePanel();
      });
      return card;
    }),
  );
}

function paintStars(row, value, preview) {
  row.querySelectorAll(".star").forEach((star) => {
    const n = Number(star.dataset.v);
    star.classList.toggle("is-on", !preview && value != null && n <= value);
    star.classList.toggle("is-preview", preview && value != null && n <= value);
  });
}

// --- Контролы, которые строятся из набора категорий ---

function buildRateKicker() {
  const count = CATEGORIES.length;
  els.rateKickerCats.textContent = `${count} ${pluralCategories(count)}`;
}

// Сортировка таблицы лидеров: «Общая оценка» + по одной опции на категорию.
function buildSortOptions() {
  els.boardSort.replaceChildren(
    ...[{ key: "total", label: "Общая оценка" }, ...CATEGORIES].map((item) => {
      const option = document.createElement("option");
      option.value = item.key;
      option.textContent = item.label;
      return option;
    }),
  );
  // Если сохранённый ключ больше не существует — возвращаемся к общей оценке.
  const known = [...els.boardSort.options].some((option) => option.value === state.sortKey);
  if (!known) state.sortKey = "total";
  els.boardSort.value = state.sortKey;
}

// Фильтр «минимум по категории»: по селекту на категорию, ключи — из CATEGORIES.
function buildCategoryFilters() {
  categoryFilterSelects.clear();
  const fragment = document.createDocumentFragment();
  for (const cat of CATEGORIES) {
    const id = `filter-${categorySlug(cat.key)}`;
    const wrapper = document.createElement("label");
    wrapper.setAttribute("for", id);

    const caption = document.createElement("span");
    caption.textContent = `${cat.label} ≥`;

    const select = document.createElement("select");
    select.id = id;
    for (let value = 0; value <= 10; value += 1) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = value === 0 ? "Любое" : String(value);
      select.append(option);
    }
    select.addEventListener("change", () => updateCategoryFilter(cat.key, select.value));

    categoryFilterSelects.set(cat.key, select);
    wrapper.append(caption, select);
    fragment.append(wrapper);
  }
  els.categoryFilters.replaceChildren(fragment);
}

// Шапка таблицы лидеров: Место / Фото / Итог / категории… / действия.
function buildTableHead() {
  const labels = ["Место", "Фото", "Итог", ...CATEGORIES.map((cat) => cat.label), ""];
  els.lbHead.replaceChildren(
    ...labels.map((text) => {
      const th = document.createElement("th");
      th.textContent = text;
      return th;
    }),
  );
}

function refreshRatePanel() {
  const photo = currentPhoto();
  if (!photo) return;
  const score = average(photo.ratings);
  const totalScore = document.getElementById("total-score");
  if (photo.skipped) {
    els.totalValue.textContent = "Skipped";
    totalScore.classList.add("is-skipped");
  } else {
    els.totalValue.textContent = formatScore(score);
    totalScore.classList.remove("is-skipped");
  }
  els.categories.querySelectorAll(".cat").forEach((card) => {
    const key = card.dataset.key;
    const value = photo.ratings[key];
    card.querySelector("[data-val]").textContent = value == null ? "—" : value;
    paintStars(card.querySelector(".stars"), value, false);
  });

  const complete = CATEGORIES.every((c) => photo.ratings[c.key] != null);
  const canProceed = complete || photo.skipped;
  els.btnNext.disabled = !canProceed;
  els.btnNext.textContent = state.index === state.order.length - 1 ? "К таблице лидеров" : "Следующий";
  els.btnPrev.disabled = state.index === 0;
  els.rateProgress.textContent = `Фото ${state.index + 1} из ${state.order.length}`;
  els.currentName.textContent = photo.name;
  els.currentName.title = photo.relativePath;
  els.topbarMeta.textContent = `${state.index + 1} / ${state.order.length}`;
}

async function showPhoto() {
  const photo = currentPhoto();
  if (!photo || !rateHandle) return;
  // Для импортированных фото без файла url === null: вьюер покажет заглушку.
  await rateHandle.load(photo.url, photo.name);
  refreshRatePanel();
}

function startSession() {
  if (!state.photos.length) return;
  state.order = shuffle(state.photos.map((p) => p.id));
  state.index = 0;
  setScreen("rate");
  if (!rateHandle) {
    rateHandle = createPhotoViewer(els.rateStage, {
      showChip: false, // процент показывается в тулбаре
      onZoom: (ratio) => {
        els.zoomLevel.textContent = `${Math.round(ratio * 100)}%`;
      },
    });
  }
  showPhoto();
}

function goPrev() {
  if (state.index === 0) return;
  state.index -= 1;
  showPhoto();
}

async function goNext() {
  const photo = currentPhoto();
  if (!photo) return;
  const complete = CATEGORIES.every((c) => photo.ratings[c.key] != null);
  if (!complete && !photo.skipped) return;
  if (state.index < state.order.length - 1) {
    state.index += 1;
    await showPhoto();
    return;
  }
  await finishRating();
}

async function skipCurrent() {
  const photo = currentPhoto();
  if (!photo) return;
  photo.skipped = true;
  for (const cat of CATEGORIES) {
    photo.ratings[cat.key] = null;
  }
  photo.thumb = null;
  invalidateTiebreak();
  if (state.index < state.order.length - 1) {
    state.index += 1;
    await showPhoto();
    return;
  }
  await finishRating();
}

function rankedPhotos(sortKey = state.sortKey) {
  const tiebreak = state.tiebreak;
  return [...state.photos]
    .filter((photo) => !photo.skipped)
    .map((photo) => {
      const score = average(photo.ratings) ?? -1;
      const sortScore = sortKey === "total" || score < 0 ? score : (photo.ratings[sortKey] ?? -1);
      return { photo, score, sortScore };
    })
    .sort((a, b) => {
      if (sortKey === "total") {
        if (b.score !== a.score) return b.score - a.score;
        // Тейбрейкер разрешает порядок только при равенстве итогового балла.
        // Фото без рейтинга (undefined) считаются «хуже» любых размеченных —
        // так разрешённая топ-8 не вытесняется снизу фото с тем же баллом.
        if (tiebreak) {
          const ra = tiebreak.get(a.photo.id);
          const rb = tiebreak.get(b.photo.id);
          const raV = ra == null ? Infinity : ra;
          const rbV = rb == null ? Infinity : rb;
          if (raV !== rbV) return raV - rbV;
        }
        return a.photo.name.localeCompare(b.photo.name, "ru");
      }
      return b.sortScore - a.sortScore || b.score - a.score || a.photo.name.localeCompare(b.photo.name, "ru");
    });
}

function matchesFilters(row) {
  const f = state.filters;
  const query = f.query.trim().toLowerCase();
  const name = String(row.photo.name || "").toLowerCase();
  const relativePath = String(row.photo.relativePath || "").toLowerCase();
  if (query && !name.includes(query) && !relativePath.includes(query)) return false;

  const total = row.score < 0 ? null : row.score;
  if (total == null) return false;
  if (f.minScore != null && total < f.minScore) return false;
  if (f.maxScore != null && total > f.maxScore) return false;
  for (const key of CATEGORY_KEYS) {
    if (f.min[key] > 0 && (row.photo.ratings[key] ?? 0) < f.min[key]) return false;
  }
  return true;
}

function renderTableOnly() {
  const ranked = rankedPhotos();
  renderTable(ranked.filter(matchesFilters), ranked);
}

// Показ/скрытие панели фильтров таблицы лидеров. Скрытое состояние хранится
// только в атрибуте hidden — никаких пересозданий элементов.
function setFiltersVisible(visible) {
  els.boardFilters.hidden = !visible;
  els.toggleFilters.setAttribute("aria-expanded", String(visible));
  els.toggleFilters.querySelector(".btn-label").textContent = visible ? "Скрыть фильтры" : "Фильтры";
}

function resetBoardFilters() {
  state.filters = {
    query: "",
    minScore: null,
    maxScore: null,
    min: zeroFilters(),
  };
  els.boardSearch.value = "";
  els.boardMinScore.value = "";
  els.boardMaxScore.value = "";
  for (const select of categoryFilterSelects.values()) select.value = "0";
}

function syncBoardFilters() {
  const f = state.filters;
  els.boardSearch.value = f.query;
  els.boardMinScore.value = f.minScore == null ? "" : String(f.minScore);
  els.boardMaxScore.value = f.maxScore == null ? "" : String(f.maxScore);
  for (const [key, select] of categoryFilterSelects) {
    select.value = String(f.min[key] ?? 0);
  }
}

function invalidateTiebreak() {
  // Любое изменение оценок сбрасывает результат тейбрейкера — при следующем
  // переходе к таблице лидеров он будет проведён заново, если ничьи ещё есть.
  state.tiebreak = null;
}

// Группы фото с одинаковым итоговым баллом внутри топ-8 (по общей оценке).
// Вне топ-8 тейбрейкер не нужен — порядок там не влияет на «призы».
function findTieGroups() {
  const ranked = rankedPhotos("total");
  const top = ranked.slice(0, 8);
  const groups = [];
  let current = [];
  let currentScore = null;
  for (const row of top) {
    if (current.length && row.score === currentScore) {
      current.push(row.photo);
    } else {
      if (current.length >= 2) groups.push(current);
      current = [row.photo];
      currentScore = row.score;
    }
  }
  if (current.length >= 2) groups.push(current);
  return groups;
}

// Точка входа в тейбрейкер: вызывается из finishRating перед таблицей лидеров.
// Возвращает Map(photoId -> rank). Если ничьих нет — пустой Map.
async function runTiebreak(groups) {
  if (!groups.length) return new Map();

  setScreen("tiebreak");
  els.topbarMeta.textContent = "Тейбрейкер";

  // Два переиспользуемых вьюера на весь экран тейбрейкера.
  if (!tiebreakHandles.length) {
    tiebreakHandles.push(
      createPhotoViewer(els.tiebreakLeft.querySelector(".tiebreak-stage"), {
        showChip: true,
        focusable: false,
      }),
      createPhotoViewer(els.tiebreakRight.querySelector(".tiebreak-stage"), {
        showChip: true,
        focusable: false,
      }),
    );
  }

  tiebreakAborted = false;
  tiebreakCompareCount = 0;
  const result = new Map();

  for (let gi = 0; gi < groups.length; gi += 1) {
    const group = groups[gi];
    if (tiebreakAborted) {
      // При отказе сохраняем текущий (именной) порядок группы.
      group.forEach((photo, idx) => result.set(photo.id, idx));
      continue;
    }
    tiebreakGroupLabel =
      `Группа ${gi + 1} из ${groups.length} · одинаковый балл ${formatScore(average(group[0].ratings))} · ` +
      `${group.length} фото с ничьей`;
    els.tiebreakInfo.textContent = tiebreakGroupLabel;
    const ordered = await orderGroup(group.slice());
    ordered.forEach((photo, idx) => result.set(photo.id, idx));
  }

  disposeTiebreakViewers();
  return result;
}

// Сортировка слиянием на попарных сравнениях пользователя: даёт полный порядок
// при минимуме сравнений (≈ N·log N) и хорошо ложится на «сначала пары, потом
// победители друг с другом».
async function orderGroup(group) {
  if (group.length <= 1) return group.slice();
  if (group.length === 2) {
    const [winner, loser] = await resolvePair(group[0], group[1]);
    return [winner, loser];
  }
  const mid = Math.ceil(group.length / 2);
  const left = await orderGroup(group.slice(0, mid));
  if (tiebreakAborted) return [...left, ...group.slice(mid)];
  const right = await orderGroup(group.slice(mid));
  if (tiebreakAborted) return [...left, ...right];
  return mergeOrdered(left, right);
}

async function mergeOrdered(left, right) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length && !tiebreakAborted) {
    const [winner] = await resolvePair(left[i], right[j]);
    if (winner === left[i]) {
      out.push(left[i]);
      i += 1;
    } else {
      out.push(right[j]);
      j += 1;
    }
  }
  while (i < left.length) out.push(left[i++]);
  while (j < right.length) out.push(right[j++]);
  return out;
}

// Показывает пару фото и ждёт выбора пользователя. Возвращает [winner, loser].
async function resolvePair(a, b) {
  if (tiebreakAborted) return [a, b];

  await Promise.all([tiebreakHandles[0].load(a.url, a.name), tiebreakHandles[1].load(b.url, b.name)]);
  if (tiebreakAborted) return [a, b];

  tiebreakCompareCount += 1;
  els.tiebreakInfo.textContent = `${tiebreakGroupLabel} · сравнение ${tiebreakCompareCount}`;
  fillTiebreakCard(els.tiebreakLeft, a);
  fillTiebreakCard(els.tiebreakRight, b);

  const choice = await waitForChoice();
  if (tiebreakAborted || choice == null) return [a, b];
  return choice === a.id ? [a, b] : [b, a];
}

function fillTiebreakCard(card, photo) {
  card.dataset.id = photo.id;
  card.querySelector(".tiebreak-name").textContent = photo.name;
  card.querySelector(".tiebreak-score").textContent = formatScore(average(photo.ratings));
}

function waitForChoice() {
  return new Promise((resolve) => {
    tiebreakChoiceResolve = resolve;
  });
}

function pickTiebreak(id) {
  if (!tiebreakChoiceResolve) return;
  const resolve = tiebreakChoiceResolve;
  tiebreakChoiceResolve = null;
  resolve(id);
}

function cancelTiebreak() {
  tiebreakAborted = true;
  if (tiebreakChoiceResolve) {
    const resolve = tiebreakChoiceResolve;
    tiebreakChoiceResolve = null;
    resolve(null);
  }
}

function disposeTiebreakViewers() {
  while (tiebreakHandles.length) {
    const handle = tiebreakHandles.pop();
    handle.dispose();
  }
  tiebreakChoiceResolve = null;
}

// Завершение оценки: при необходимости проводит тейбрейкер, затем открывает
// таблицу лидеров. Тейбрейкер проводится один раз и кешируется в state.tiebreak,
// пока оценки не изменятся (что сбрасывает кеш через invalidateTiebreak).
async function finishRating() {
  if (state.tiebreak == null) {
    const groups = findTieGroups();
    state.tiebreak = groups.length ? await runTiebreak(groups) : new Map();
  }
  await openLeaderboard();
}

async function openLeaderboard() {
  setScreen("board");
  // У импортированной сессии нет экрана оценки — прячем «вернуться к оценкам».
  els.btnBackRate.hidden = !!state.imported;
  const ratedCount = state.photos.filter((photo) => !photo.skipped).length;
  els.topbarMeta.textContent = `Оценено: ${ratedCount}`;
  const activePhotos = state.photos.filter((photo) => !photo.skipped);
  await Promise.all(activePhotos.map((photo) => (photo.thumb ? photo.thumb : captureThumb(photo))));
  await renderLeaderboard();
}

async function renderLeaderboard() {
  const ranked = rankedPhotos();
  renderTable(ranked.filter(matchesFilters), ranked);
  renderPodium(ranked.slice(0, 3));
}

function renderTable(ranked, allRanked = ranked) {
  const ratedCount = allRanked.filter((row) => row.score >= 0).length;
  if (!ratedCount || !ranked.length) {
    const empty = document.createElement("tr");
    // Место + Фото + Итог + категории + действия.
    const message = ratedCount ? "Ничего не найдено по фильтрам" : "Нет оценённых фото";
    empty.innerHTML = `<td colspan="${CATEGORIES.length + 4}" class="table-empty">${message}</td>`;
    els.lbBody.replaceChildren(empty);
    return;
  }

  const places = new Map(allRanked.map((row, index) => [row.photo.id, index + 1]));
  els.lbBody.replaceChildren(
    ...ranked.map((row, i) => {
      const place = places.get(row.photo.id) ?? i + 1;
      const tr = document.createElement("tr");
      const badgeClass = place === 1 ? "gold" : place === 2 ? "silver" : place === 3 ? "bronze" : "";
      // Столбцы категорий — по одному на каждую категорию, в порядке CATEGORIES.
      const categoryCells = CATEGORY_KEYS.map(
        (key) => `<td class="cat-cell" data-key="${key}">${row.photo.ratings[key] ?? "—"}</td>`,
      ).join("");
      tr.innerHTML = `
        <td><span class="place-badge ${badgeClass}">${place}</span></td>
        <td>
          <div class="photo-cell">
            <div class="thumb-wrap" data-tip="${escapeAttr(row.photo.relativePath)}" role="button" tabindex="0" aria-label="Открыть подробный просмотр">
              <img alt="" />
            </div>
            <span class="photo-name" role="button" tabindex="0"></span>
          </div>
        </td>
        <td class="score-strong">${formatScore(row.score < 0 ? null : row.score)}</td>
        ${categoryCells}
        <td>
          <button type="button" class="icon-btn" aria-label="Открыть расположение файла" title="Открыть папку">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/>
            </svg>
          </button>
        </td>
      `;
      const img = tr.querySelector("img");
      img.src = row.photo.thumb || "";
      img.alt = row.photo.name;
      const wrap = tr.querySelector(".thumb-wrap");
      const name = tr.querySelector(".photo-name");
      const openDetailFromKeyboard = (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void openDetail(row.photo);
      };
      name.textContent = row.photo.name;
      wrap.addEventListener("pointerenter", (event) => showTip(event, row.photo.relativePath));
      wrap.addEventListener("pointerleave", hideTip);
      wrap.addEventListener("click", () => void openDetail(row.photo));
      wrap.addEventListener("keydown", openDetailFromKeyboard);
      name.addEventListener("click", () => void openDetail(row.photo));
      name.addEventListener("keydown", openDetailFromKeyboard);
      tr.querySelector(".icon-btn").addEventListener("click", () => onReveal(row.photo));
      return tr;
    }),
  );
}

function renderPodium(top) {
  els.podium.replaceChildren();
  if (!top.length) {
    els.podium.innerHTML = `<div class="podium-empty">Нет оценённых фото</div>`;
    return;
  }

  const labels = ["1 место", "2 место", "3 место"];
  for (let i = 0; i < 3; i += 1) {
    const card = document.createElement("article");
    card.className = `podium-card${i === 0 ? " is-first" : ""}`;
    card.dataset.place = String(i + 1);
    if (!top[i]) {
      card.innerHTML = `<div class="podium-place">${labels[i]}</div><div class="podium-stage"></div><div class="podium-name">—</div>`;
      els.podium.append(card);
      continue;
    }
    const { photo, score } = top[i];
    // Превью статичное: интерактивный просмотр — в детальном диалоге.
    // Без файла (импорт) — плейсхолдер.
    card.innerHTML = `
      <div class="podium-place">${labels[i]}</div>
      <div class="podium-stage"><img class="podium-ph" alt="" /></div>
      <div class="podium-name" title="${escapeAttr(photo.relativePath)}"></div>
      <div class="podium-score">${formatScore(score < 0 ? null : score)}</div>
    `;
    card.querySelector(".podium-name").textContent = photo.name;
    const img = card.querySelector(".podium-ph");
    img.src = photo.thumb || thumbPlaceholder();
    img.alt = photo.name;
    els.podium.append(card);
  }
}

let tipNode = null;
function showTip(event, text) {
  hideTip();
  tipNode = document.createElement("div");
  tipNode.className = "tooltip";
  tipNode.textContent = text;
  document.body.append(tipNode);
  const move = (e) => {
    tipNode.style.left = `${e.clientX}px`;
    tipNode.style.top = `${e.clientY}px`;
  };
  move(event);
  tipNode._move = move;
  window.addEventListener("pointermove", move);
}

function hideTip() {
  if (!tipNode) return;
  window.removeEventListener("pointermove", tipNode._move);
  tipNode.remove();
  tipNode = null;
}

function fillPathFields(result, pathNode, dirNode) {
  pathNode.textContent = result.path || "—";
  dirNode.textContent = result.dirPath || result.path || "—";
}

function onReveal(photo) {
  // Из браузера нельзя открыть системный проводник и выделить файл — показываем
  // известный путь к файлу и папке, чтобы пользователь скопировал его и открыл
  // папку вручную. Никаких диалогов выбора файлов/папок.
  const result = revealPhoto(photo);
  fillPathFields(result, els.revealPath, els.revealDir);
  if (typeof els.dialog.showModal === "function") els.dialog.showModal();
  else showToast(result.path || result.dirPath);
}

function renderDetailCategories(photo) {
  els.detailCategories.replaceChildren(
    ...CATEGORIES.map((cat) => {
      const row = document.createElement("div");
      row.className = "detail-category";
      // data-key даёт строке цвет категории (--cat-color из css/app.css).
      row.dataset.key = cat.key;
      row.innerHTML = `<span><i class="swatch"></i>${cat.label}</span><strong></strong>`;
      row.querySelector("strong").textContent = photo.ratings[cat.key] ?? "—";
      return row;
    }),
  );
}

async function openDetail(photo) {
  if (!photo) return;
  if (els.detailDialog.open) els.detailDialog.close();

  detailRenderToken += 1;
  const renderToken = detailRenderToken;
  detailPhoto = photo;
  els.detailName.textContent = photo.name;
  const score = average(photo.ratings);
  els.detailScore.textContent = photo.skipped ? "Пропущено" : formatScore(score);
  renderDetailCategories(photo);

  const hasFile = !!photo.url;
  els.detailPlaceholder.hidden = hasFile;
  if (!hasFile) {
    els.detailPlaceholder.src = photo.thumb || thumbPlaceholder();
  }

  if (typeof els.detailDialog.showModal !== "function") {
    showToast(hasFile ? "Подробный просмотр недоступен" : photo.name);
    return;
  }
  els.detailDialog.showModal();
  if (!hasFile) return;

  try {
    const handle = createPhotoViewer(els.detailStage, {
      showChip: true,
      alt: photo.name,
    });
    if (renderToken !== detailRenderToken || detailPhoto !== photo || !els.detailDialog.open) {
      handle.dispose();
      return;
    }
    detailHandle = handle;
    await handle.load(photo.url, photo.name);
  } catch {
    if (renderToken === detailRenderToken && detailPhoto === photo) {
      showToast("Не удалось открыть просмотр фото");
    }
  }
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast("Скопировано в буфер обмена");
    return;
  } catch {
    // clipboard API может быть недоступен — пробуем запасной вариант.
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  showToast(ok ? "Скопировано в буфер обмена" : "Не удалось скопировать");
}

function handleDetailClose() {
  detailRenderToken += 1;
  if (detailHandle) {
    detailHandle.dispose();
    detailHandle = null;
  }
  detailPhoto = null;
  els.detailPlaceholder.hidden = true;
}

function backToRatings() {
  setScreen("rate");
  showPhoto();
}

function newSession() {
  if (els.detailDialog.open) els.detailDialog.close();
  else if (detailHandle || detailPhoto) handleDetailClose();
  disposeTiebreakViewers();
  disposeThumbEngine();
  if (rateHandle) {
    rateHandle.dispose();
    rateHandle = null;
  }
  clearAll();
  state.order = [];
  state.index = 0;
  state.sortKey = "total";
  state.tiebreak = null;
  state.imported = false;
  resetBoardFilters();
  setFiltersVisible(false);
  setScreen("upload");
}

// --- Экспорт / импорт оценок ---

// Версия формата: 4 — оценка фото, набор категорий (причёска, цвет глаз,
// верхняя одежда, нижняя одежда, обувь, аксессуары), без 3D-модели. В файле
// дублируется список ключей категорий, чтобы импорт мог честно сказать о
// несовпадении с текущим набором. Более старые файлы (v1–v2 — оценка скинов,
// v3 — фото по категориям композиция/свет/цвет/резкость/детализация/эмоция/
// атмосфера) при импорте читаются, но по новым категориям в них оценок не
// будет — превью импорта предупредит об этом.
const EXPORT_VERSION = 4;

function freshId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `photo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function exportRatings() {
  const rated = state.photos.filter((p) => !p.skipped);
  if (!rated.length) {
    showToast("Нет оценённых фото для сохранения");
    return;
  }
  const data = {
    version: EXPORT_VERSION,
    app: "photovote",
    date: new Date().toISOString(),
    categories: CATEGORY_KEYS.slice(),
    photos: state.photos.map((p) => {
      // Пропущенные фото сохраняются без оценок, остальные — по всем категориям.
      const ratings = CATEGORY_KEYS.reduce((acc, key) => {
        acc[key] = p.skipped ? null : (p.ratings[key] ?? null);
        return acc;
      }, {});
      return {
        name: p.name,
        relativePath: p.relativePath,
        ratings,
        note: p.note || "",
        skipped: !!p.skipped,
      };
    }),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `photovote-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast("Оценки сохранены в JSON");
}

function parseSession(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Файл не является корректным JSON");
  }
  const rawList = Array.isArray(data?.photos) ? data.photos : Array.isArray(data?.skins) ? data.skins : null;
  if (!data || typeof data !== "object" || !rawList) {
    throw new Error("Неверная структура файла: ожидается объект со списком photos");
  }
  // Ключи категорий, которые реально встречаются в файле: нужны, чтобы
  // предупредить о файле, сохранённом для другого набора категорий.
  const fileKeys = new Set();
  const photos = rawList.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Фото #${i + 1}: неверная запись`);
    }
    const name = String(raw.name || `photo-${i + 1}.jpg`);
    const relativePath = String(raw.relativePath || name);
    const skipped = !!raw.skipped;
    const inRatings = raw.ratings && typeof raw.ratings === "object" ? raw.ratings : {};
    Object.keys(inRatings).forEach((key) => fileKeys.add(key));
    const ratings = {};
    for (const k of CATEGORY_KEYS) {
      const v = inRatings[k];
      ratings[k] = Number.isFinite(v) && v >= 0 && v <= 10 ? Number(v) : null;
    }
    return {
      id: freshId(),
      name,
      relativePath,
      file: null,
      url: null,
      width: null,
      height: null,
      fileHandle: null,
      dirHandle: null,
      ratings,
      thumb: null,
      note: typeof raw.note === "string" ? raw.note : "",
      skipped,
      imported: true,
    };
  });
  return {
    version: Number(data.version) || 1,
    date: typeof data.date === "string" ? data.date : null,
    // v3+ пишет список категорий явно; у более старых файлов берём его из оценок.
    categories: Array.isArray(data.categories) ? data.categories.map((key) => String(key)) : [...fileKeys],
    photos,
  };
}

// Категории, которых нет в загружаемом файле, — по ним оценки останутся пустыми.
function missingCategories(session) {
  const known = new Set(Array.isArray(session.categories) ? session.categories : []);
  return CATEGORIES.filter((cat) => !known.has(cat.key)).map((cat) => cat.label);
}

function formatSessionDate(iso) {
  if (!iso) return "дата неизвестна";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function normalizePhotoPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function photoFileName(value) {
  const path = normalizePhotoPath(value);
  return path.slice(path.lastIndexOf("/") + 1);
}

function findImportedFileMatches(importedPhotos, loadedPhotos) {
  const available = loadedPhotos.filter((photo) => photo.file || photo.url);
  const used = new Set();
  const matches = new Map();

  for (const importedPhoto of importedPhotos) {
    const importedPath = normalizePhotoPath(importedPhoto.relativePath);
    const importedName = photoFileName(importedPhoto.name || importedPhoto.relativePath);
    let candidates = available.filter(
      (loadedPhoto) => !used.has(loadedPhoto.id) && normalizePhotoPath(loadedPhoto.relativePath) === importedPath,
    );
    if (candidates.length !== 1) {
      candidates = available.filter(
        (loadedPhoto) => !used.has(loadedPhoto.id) && photoFileName(loadedPhoto.name) === importedName,
      );
    }
    if (candidates.length !== 1) continue;
    const loadedPhoto = candidates[0];
    used.add(loadedPhoto.id);
    matches.set(importedPhoto.id, loadedPhoto);
  }
  return matches;
}

function mergeImportedFiles(session) {
  const loadedPhotos = state.photos;
  const matches = findImportedFileMatches(session.photos, loadedPhotos);
  const matchedLoadedPhotos = new Set(matches.values());
  const mergedPhotos = session.photos.map((importedPhoto) => {
    const loadedPhoto = matches.get(importedPhoto.id);
    if (!loadedPhoto) return importedPhoto;
    return {
      ...importedPhoto,
      file: loadedPhoto.file,
      url: loadedPhoto.url,
      width: loadedPhoto.width,
      height: loadedPhoto.height,
      fileHandle: loadedPhoto.fileHandle,
      dirHandle: loadedPhoto.dirHandle,
      // JSON-оценки и заметка имеют приоритет; превью создадим заново.
      thumb: null,
    };
  });

  loadedPhotos.forEach((loadedPhoto) => {
    if (!matchedLoadedPhotos.has(loadedPhoto)) revokePhoto(loadedPhoto);
  });
  return { photos: mergedPhotos, matchedCount: matches.size };
}

function showImportPreview(session) {
  const total = session.photos.length;
  const rated = session.photos.filter((p) => !p.skipped).length;
  const skipped = total - rated;
  const sample = session.photos.slice(0, 4).map((p) => escapeAttr(p.name)).join(", ");
  const matches = findImportedFileMatches(session.photos, state.photos).size;
  const hasLoadedFiles = state.photos.some((photo) => photo.file || photo.url);
  const previewHint = matches
    ? `Будут подключены локальные файлы для ${matches} из ${total} фото; для остальных останутся плейсхолдеры.`
    : hasLoadedFiles
      ? "Совпадений с уже загруженными файлами не найдено; для фото будут показаны плейсхолдеры."
      : "Если фото не загружены, для них будут показаны плейсхолдеры вместо превью.";
  const missing = missingCategories(session);
  const missingHint = missing.length
    ? `<p class="import-warning" style="margin-top:8px">Файл сохранён для другого набора категорий: нет оценок по «${missing
        .map((label) => escapeAttr(label))
        .join(", ")}» — они будут пустыми.</p>`
    : "";
  els.importPreview.innerHTML = `
    <p class="muted">Сессия от <b>${formatSessionDate(session.date)}</b></p>
    <p>Фото в файле: <b>${total}</b>${rated !== total ? ` (оценено ${rated}, пропущено ${skipped})` : ""}</p>
    ${sample ? `<p class="muted" style="margin-top:8px">Например: ${sample}${total > 4 ? "…" : ""}</p>` : ""}
    <p class="muted" style="margin-top:8px">${previewHint}</p>
    ${missingHint}
    <p class="muted" style="margin-top:8px">Сразу откроется таблица лидеров.</p>
  `;
  if (typeof els.importDialog.showModal === "function") els.importDialog.showModal();
  else showToast(`Импорт: ${total} фото`);
}

function loadImportedSession(session) {
  if (typeof els.importDialog.close === "function") els.importDialog.close();
  const merged = mergeImportedFiles(session);
  state.photos = merged.photos;
  state.rejected = [];
  state.skipped = 0;
  state.order = [];
  state.index = 0;
  state.sortKey = "total";
  state.tiebreak = null;
  state.imported = true;
  resetBoardFilters();
  setFiltersVisible(false);
  if (merged.matchedCount) {
    showToast(`Подключены локальные файлы: ${merged.matchedCount} из ${session.photos.length}`);
  }
  // Импортированные данные показываем сразу, без экрана оценки и тейбрейкера.
  openLeaderboard();
}

async function handleImportFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    showToast("Не удалось прочитать файл");
    return;
  }
  let session;
  try {
    session = parseSession(text);
  } catch (error) {
    showToast(error.message || "Неверный формат файла");
    return;
  }
  if (!session.photos.length) {
    showToast("В файле нет фото");
    return;
  }
  pendingImport = session;
  showImportPreview(session);
}

function bindUpload() {
  const zone = els.dropzone;

  const setOver = (on) => zone.classList.toggle("is-over", on);

  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    setOver(true);
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setOver(true);
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget)) setOver(false);
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    setOver(false);
    const entries = await collectFromDataTransfer(e.dataTransfer);
    await ingestEntries(entries);
  });

  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.inputFiles.click();
    }
  });

  els.btnPickFiles.addEventListener("click", async () => {
    if (supportsFsAccess()) {
      try {
        const entries = await pickFilesWithFs();
        await ingestEntries(entries);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    els.inputFiles.click();
  });

  els.btnPickFolder.addEventListener("click", async () => {
    if (supportsDirPicker()) {
      try {
        const entries = await pickFolderWithFs();
        await ingestEntries(entries);
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    els.inputFolder.click();
  });

  els.inputFiles.addEventListener("change", async () => {
    const entries = filesFromInput(els.inputFiles.files);
    els.inputFiles.value = "";
    await ingestEntries(entries);
  });

  els.inputFolder.addEventListener("change", async () => {
    const entries = filesFromInput(els.inputFolder.files);
    els.inputFolder.value = "";
    await ingestEntries(entries);
  });

  els.btnClearAll.addEventListener("click", clearAll);
  els.btnClearInvalid.addEventListener("click", () => {
    state.rejected = [];
    renderUpload();
  });
  els.btnStart.addEventListener("click", startSession);

  els.btnImport.addEventListener("click", () => els.inputImport.click());
  els.inputImport.addEventListener("change", async () => {
    const file = els.inputImport.files?.[0];
    els.inputImport.value = "";
    if (file) await handleImportFile(file);
  });
}

function readScoreFilter(input) {
  const raw = input.value.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(10, Math.max(1, value));
}

function updateCategoryFilter(key, value) {
  const number = Number(value);
  state.filters.min[key] = Number.isFinite(number) ? Math.min(10, Math.max(0, number)) : 0;
  renderTableOnly();
}

function bindRate() {
  // Всё, что зависит от набора категорий, строится из CATEGORIES один раз.
  buildRateKicker();
  buildCategories();
  buildSortOptions();
  buildCategoryFilters();
  buildTableHead();
  els.btnPrev.addEventListener("click", goPrev);
  els.btnNext.addEventListener("click", goNext);
  els.btnSkip.addEventListener("click", skipCurrent);
  els.btnZoomIn.addEventListener("click", () => rateHandle?.zoomIn());
  els.btnZoomOut.addEventListener("click", () => rateHandle?.zoomOut());
  els.btnZoomFit.addEventListener("click", () => rateHandle?.resetView());
  els.boardSort.addEventListener("change", async () => {
    state.sortKey = els.boardSort.value;
    await renderLeaderboard();
  });
  els.boardSearch.addEventListener("input", () => {
    state.filters.query = els.boardSearch.value;
    renderTableOnly();
  });
  [els.boardMinScore, els.boardMaxScore].forEach((input) => {
    input.addEventListener("input", () => {
      state.filters[input === els.boardMinScore ? "minScore" : "maxScore"] = readScoreFilter(input);
      renderTableOnly();
    });
  });
  // Слушатели селектов «минимум по категории» навешиваются в buildCategoryFilters.
  els.btnResetFilters.addEventListener("click", () => {
    resetBoardFilters();
    renderTableOnly();
  });
  els.toggleFilters.addEventListener("click", () => {
    setFiltersVisible(els.boardFilters.hidden);
  });
  els.btnBackRate.addEventListener("click", backToRatings);
  els.btnNewSession.addEventListener("click", newSession);

  // Путь к файлу: копирование без диалогов выбора.
  els.btnCopyPath.addEventListener("click", () => copyText(els.revealPath.textContent.trim()));
  els.btnCopyDir.addEventListener("click", () => copyText(els.revealDir.textContent.trim()));
  els.detailDialog.addEventListener("close", handleDetailClose);
  els.detailDialog.addEventListener("click", (event) => {
    if (event.target === els.detailDialog) els.detailDialog.close();
  });

  // Экспорт оценок в JSON.
  els.btnExport.addEventListener("click", exportRatings);

  // Тейбрейкер: клик по карточке = выбор фото; «оставить как есть» = отмена.
  // Клик, выросший из перетаскивания фото, гасится вьюером.
  els.tiebreakLeft.addEventListener("click", () => {
    const handle = tiebreakHandles[0];
    if (handle && handle.suppressClick()) return;
    pickTiebreak(els.tiebreakLeft.dataset.id);
  });
  els.tiebreakRight.addEventListener("click", () => {
    const handle = tiebreakHandles[1];
    if (handle && handle.suppressClick()) return;
    pickTiebreak(els.tiebreakRight.dataset.id);
  });
  els.btnTiebreakSkip.addEventListener("click", cancelTiebreak);

  // Подтверждение импорта.
  els.btnImportConfirm.addEventListener("click", () => {
    if (pendingImport) loadImportedSession(pendingImport);
    pendingImport = null;
  });

  window.addEventListener("keydown", (event) => {
    if (state.screen !== "rate") return;
    // На сцене в фокусе стрелки/зумные клавиши обрабатывает сам вьюер —
    // навигация не должна дублироваться. Прочие клавиши (например, «s») — как обычно.
    const stageKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_", "0"]);
    if (event.target === els.rateStage && stageKeys.has(event.key)) return;
    if (event.key === "ArrowLeft") goPrev();
    if (event.key === "ArrowRight") goNext();
    if (event.key === "s" || event.key === "S") skipCurrent();
  });
}

bindUpload();
bindRate();
setScreen("upload");
renderUpload();

["dragover", "drop"].forEach((type) => {
  window.addEventListener(type, (event) => {
    event.preventDefault();
  });
});
