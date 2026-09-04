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
  backdropCssValue,
  backdropLabel,
  backdropTone,
  getBackdrop,
  parseBackdrop,
  setBackdrop,
  subscribeBackdrop,
} from "./backdrop.js";
import { createBackdropControl } from "./backdrop-ui.js";
import {
  BUILTIN_PRESETS,
  SCALES,
  activeCategories,
  activeCategoryKeys,
  activePreset,
  categorySlug,
  deleteCustomPreset,
  emptyRatings,
  getScale,
  listPresets,
  makeCategoryKey,
  parsePresetFile,
  pluralCategories,
  resetSettings,
  saveCustomPreset,
  serializePreset,
  setActivePresetId,
  setScale,
} from "./categories.js";

// Палитра акцентов категорий. Цвет задаётся индексом категории в пресете,
// поэтому работает и для пользовательских пресетов (для встроенных она
// повторяет прежние цвета по ключам).
const PALETTE = [
  "#f492b3",
  "#57a8ff",
  "#e8c36a",
  "#b4c0ff",
  "#ff8b7a",
  "#7ee0c4",
  "#b78bf2",
  "#ffb454",
  "#5ee0e8",
  "#9ee07c",
  "#ff6f61",
  "#c5a3ff",
];

function catColor(index) {
  return PALETTE[index % PALETTE.length];
}

// Минимальное значение фильтра по категории (0 = «любое»).
function zeroFilters() {
  return emptyRatings(0);
}

// Числа без «хвоста»: 84 -> "84", 84.3 -> "84.3".
function formatNumber(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
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
  // Селекты «минимум по категории» строятся динамически из активного пресета.
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
  // Settings (пресеты + шкала)
  settingsPreset: document.getElementById("settings-preset"),
  settingsPresetCats: document.getElementById("preset-cats"),
  settingsScale: document.getElementById("settings-scale"),
  btnPresetNew: document.getElementById("btn-preset-new"),
  btnPresetEdit: document.getElementById("btn-preset-edit"),
  btnPresetDownload: document.getElementById("btn-preset-download"),
  btnPresetDelete: document.getElementById("btn-preset-delete"),
  btnPresetUpload: document.getElementById("btn-preset-upload"),
  btnSettingsReset: document.getElementById("btn-settings-reset"),
  // Фон оцениваемого фото (панель настроек + кнопка в тулбаре просмотра)
  settingsBackdrop: document.getElementById("settings-backdrop"),
  backdropWrap: document.getElementById("backdrop-wrap"),
  btnBackdrop: document.getElementById("btn-backdrop"),
  backdropSwatch: document.getElementById("backdrop-swatch"),
  backdropPopover: document.getElementById("backdrop-popover"),
  backdropPopoverBody: document.getElementById("backdrop-popover-body"),
  backdropValue: document.getElementById("backdrop-value"),
  btnBackdropClose: document.getElementById("btn-backdrop-close"),
  inputPreset: document.getElementById("input-preset"),
  presetDialog: document.getElementById("preset-dialog"),
  presetDialogTitle: document.getElementById("preset-dialog-title"),
  presetForm: document.getElementById("preset-form"),
  presetName: document.getElementById("preset-name"),
  presetCatEditor: document.getElementById("preset-cat-editor"),
  btnCatAdd: document.getElementById("btn-cat-add"),
  btnPresetCancel: document.getElementById("btn-preset-cancel"),
  btnPresetSave: document.getElementById("btn-preset-save"),
  confirmDialog: document.getElementById("confirm-dialog"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmText: document.getElementById("confirm-text"),
  confirmOk: document.getElementById("confirm-ok"),
  confirmCancel: document.getElementById("confirm-cancel"),
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
// Контролы фона живут всё время работы приложения и синхронизируются между
// собой через подписку на состояние (js/backdrop.js).
let backdropPopoverControl = null;
let backdropPopoverOpen = false;

function currentPhoto() {
  const id = state.order[state.index];
  return state.photos.find((p) => p.id === id) || null;
}

function average(ratings) {
  const keys = activeCategoryKeys();
  if (!keys.length) return null;
  const values = keys.map((key) => ratings[key]);
  if (values.some((v) => v == null)) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function formatScore(score) {
  const max = getScale();
  if (score == null) return `—/${max}`;
  return `${formatNumber(score)}/${max}`;
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
  // Поповер фона живёт в тулбаре экрана оценки: при уходе с него закрываем.
  if (name !== "rate") setBackdropPopover(false, { restoreFocus: false });
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
  const scale = getScale();
  const cats = activeCategories();
  const isNumeric = scale === 100;
  els.categories.replaceChildren(
    ...cats.map((cat, index) => {
      const card = document.createElement("div");
      card.className = "cat";
      card.dataset.key = cat.key;
      card.style.setProperty("--cat-color", catColor(index));

      card.innerHTML = `
        <div class="cat-top">
          <div class="cat-name"><i class="swatch"></i>${cat.label}</div>
          <div class="cat-val" data-val>—</div>
        </div>
        ${
          isNumeric
            ? `
          <div class="stepper" role="group" aria-label="${cat.label}">
            <button type="button" class="step-btn" data-act="minus" aria-label="${cat.label}: уменьшить на 10">−10</button>
            <input class="stepper-input" type="number" inputmode="numeric" min="0" max="100" step="1" aria-label="${cat.label}: баллы от 0 до 100" />
            <button type="button" class="step-btn" data-act="plus" aria-label="${cat.label}: увеличить на 10">+10</button>
          </div>
          <p class="stepper-hint">0 — без оценки · шаг ±10</p>`
            : `
          <div class="stars" role="radiogroup" aria-label="${cat.label}"></div>`
        }
      `;

      if (isNumeric) {
        const input = card.querySelector(".stepper-input");
        const minus = card.querySelector('[data-act="minus"]');
        const plus = card.querySelector('[data-act="plus"]');

        // Ручной ввод: значение применяется сразу, как только в поле целое число.
        input.addEventListener("input", () => {
          const parsed = Number.parseInt(input.value, 10);
          if (!Number.isFinite(parsed)) return;
          setRating(cat.key, parsed);
        });
        minus.addEventListener("click", () => {
          const current = currentPhoto()?.ratings[cat.key];
          setRating(cat.key, (current || 0) - 10);
        });
        plus.addEventListener("click", () => {
          const current = currentPhoto()?.ratings[cat.key];
          setRating(cat.key, (current || 0) + 10);
        });
      } else {
        const row = card.querySelector(".stars");
        // Количество кружков зависит от шкалы: 5 или 10.
        row.style.gridTemplateColumns = `repeat(${scale}, 1fr)`;
        for (let i = 1; i <= scale; i += 1) {
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
          setRating(cat.key, Number(btn.dataset.v));
        });
      }
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

// Показывает состояние числовой (100-балльной) категории.
function paintNumeric(card, value) {
  const input = card.querySelector(".stepper-input");
  const minus = card.querySelector('[data-act="minus"]');
  const plus = card.querySelector('[data-act="plus"]');
  if (!input) return;
  input.value = value == null ? "" : String(value);
  if (minus) minus.disabled = (value || 0) <= 0;
  if (plus) plus.disabled = (value || 0) >= 100;
}

// Выставляет балл за категорию и обновляет панель. 0 на 100-балльной шкале
// трактуется как «ещё не оценено», как и пустое значение.
function setRating(key, rawValue) {
  const photo = currentPhoto();
  if (!photo) return;
  const scale = getScale();
  let value = typeof rawValue === "number" ? rawValue : Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value)) value = 0;
  value = Math.max(0, Math.min(scale, Math.round(value)));
  photo.ratings[key] = value === 0 ? null : value;
  photo.skipped = false;
  invalidateTiebreak();
  refreshRatePanel();
}

// --- Контролы, которые строятся из набора категорий ---

function buildRateKicker() {
  const count = activeCategories().length;
  const scale = getScale();
  els.rateKickerCats.textContent = `${count} ${pluralCategories(count)} · шкала ${scale}`;
}

// Сортировка таблицы лидеров: «Общая оценка» + по одной опции на категорию.
function buildSortOptions() {
  els.boardSort.replaceChildren(
    ...[{ key: "total", label: "Общая оценка" }, ...activeCategories()].map((item) => {
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

// Фильтр «минимум по категории»: по селекту на категорию.
function buildCategoryFilters() {
  const scale = getScale();
  categoryFilterSelects.clear();
  const fragment = document.createDocumentFragment();
  for (const cat of activeCategories()) {
    const id = `filter-${categorySlug(cat.key)}`;
    const wrapper = document.createElement("label");
    wrapper.setAttribute("for", id);

    const caption = document.createElement("span");
    caption.textContent = `${cat.label} ≥`;

    const select = document.createElement("select");
    select.id = id;
    for (let value = 0; value <= scale; value += 1) {
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
  const labels = ["Место", "Фото", "Итог", ...activeCategories().map((cat) => cat.label), ""];
  els.lbHead.replaceChildren(
    ...labels.map((text) => {
      const th = document.createElement("th");
      th.textContent = text;
      return th;
    }),
  );
}

// Ограничения полей фильтра «итоговый балл» зависят от активной шкалы.
function syncScoreFilterAttrs() {
  const scale = getScale();
  for (const input of [els.boardMinScore, els.boardMaxScore]) {
    input.min = 1;
    input.max = scale;
    input.step = scale === 100 ? "1" : "0.1";
  }
  els.boardMaxScore.placeholder = String(scale);
}

function refreshRatePanel() {
  const photo = currentPhoto();
  if (!photo) return;
  const score = average(photo.ratings);
  const totalScore = document.getElementById("total-score");
  if (photo.skipped) {
    els.totalValue.textContent = "Пропущено";
    totalScore.classList.add("is-skipped");
  } else {
    els.totalValue.textContent = formatScore(score);
    totalScore.classList.remove("is-skipped");
  }
  els.categories.querySelectorAll(".cat").forEach((card) => {
    const key = card.dataset.key;
    const value = photo.ratings[key];
    card.querySelector("[data-val]").textContent = value == null ? "—" : value;
    if (card.querySelector(".stepper")) paintNumeric(card, value);
    else paintStars(card.querySelector(".stars"), value, false);
  });

  const complete = activeCategoryKeys().every((key) => photo.ratings[key] != null);
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
  const complete = activeCategoryKeys().every((key) => photo.ratings[key] != null);
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
  for (const key of activeCategoryKeys()) {
    photo.ratings[key] = null;
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
  for (const key of activeCategoryKeys()) {
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
  syncScoreFilterAttrs();
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
    empty.innerHTML = `<td colspan="${activeCategories().length + 4}" class="table-empty">${message}</td>`;
    els.lbBody.replaceChildren(empty);
    return;
  }

  const places = new Map(allRanked.map((row, index) => [row.photo.id, index + 1]));
  els.lbBody.replaceChildren(
    ...ranked.map((row, i) => {
      const place = places.get(row.photo.id) ?? i + 1;
      const tr = document.createElement("tr");
      const badgeClass = place === 1 ? "gold" : place === 2 ? "silver" : place === 3 ? "bronze" : "";
      // Столбцы категорий — по одному на каждую категорию активного пресета.
      const categoryCells = activeCategoryKeys()
        .map(
          (key, index) =>
            `<td class="cat-cell" data-key="${key}" style="--cat-color:${catColor(index)}">${
              row.photo.ratings[key] ?? "—"
            }</td>`,
        )
        .join("");
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
    ...activeCategories().map((cat, index) => {
      const row = document.createElement("div");
      row.className = "detail-category";
      row.dataset.key = cat.key;
      // data-key даёт цвет категории; для пользовательских пресетов цвет
      // назначается по индексу из палитры.
      row.style.setProperty("--cat-color", catColor(index));
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

// Версия формата: 6 — оценка фото по активному пресету категорий и активной
// шкале (5/10/100) плюс фон под фото (режим и свой цвет), чтобы загруженная
// сессия открывалась так же, как её оценивали. В файле дублируется набор
// категорий и шкала, чтобы импорт мог восстановить тот же пресет и те же баллы.
// Более старые файлы (v1–v2 — оценка скинов, v3 — фото по категориям
// композиция/свет/цвет/резкость/детализация/эмоция/атмосфера, v4 — фото по
// категориям «Человека» со шкалой 10, v5 — то же без поля фона) читаются, но
// пресет/шкала из v1–v4 не восстанавливаются — превью импорта предупредит
// о несовпадении категорий.
const EXPORT_VERSION = 6;

function freshId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `photo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Нормализует блок preset из файла оценок (или файла пресета).
function normalizePreset(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cats = (Array.isArray(raw.categories) ? raw.categories : [])
    .filter((c) => c && typeof c === "object" && String(c.label || "").trim())
    .map((c) => ({ key: String(c.key || ""), label: String(c.label).trim() }));
  if (!cats.length) return null;
  const used = new Set();
  for (const cat of cats) {
    if (!cat.key || used.has(cat.key)) cat.key = makeCategoryKey(cat.label, used);
    used.add(cat.key);
  }
  return {
    id: String(raw.id || ""),
    label: String(raw.label || "Импортированный пресет").trim() || "Импортированный пресет",
    categories: cats,
  };
}

function exportRatings() {
  const rated = state.photos.filter((p) => !p.skipped);
  if (!rated.length) {
    showToast("Нет оценённых фото для сохранения");
    return;
  }
  const preset = activePreset();
  const data = {
    version: EXPORT_VERSION,
    app: "photovote",
    date: new Date().toISOString(),
    scale: getScale(),
    // Фон под фото сохраняется вместе с сессией: при загрузке файла
    // фото будут показаны так же, как их оценивали.
    backdrop: getBackdrop(),
    preset: {
      id: preset.id,
      label: preset.label,
      categories: preset.categories.map((c) => ({ key: c.key, label: c.label })),
    },
    categories: activeCategoryKeys(),
    photos: state.photos.map((p) => {
      // Пропущенные фото сохраняются без оценок, остальные — по всем категориям.
      const ratings = {};
      for (const key of activeCategoryKeys()) {
        ratings[key] = p.skipped ? null : (p.ratings[key] ?? null);
      }
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
  const fileScale = SCALES.some((s) => s.value === data.scale) ? data.scale : null;
  // Для старых файлов без поля scale считаем, что они записаны по шкале 10.
  const valueMax = fileScale || 10;
  const photos = rawList.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`Фото #${i + 1}: неверная запись`);
    }
    const name = String(raw.name || `photo-${i + 1}.jpg`);
    const relativePath = String(raw.relativePath || name);
    const skipped = !!raw.skipped;
    const inRatings = raw.ratings && typeof raw.ratings === "object" ? raw.ratings : {};
    Object.keys(inRatings).forEach((key) => fileKeys.add(key));
    // Сохраняем все встреченные в файле оценки: если пресет из файла будет
    // применён, ни одна оценка не потеряется.
    const ratings = {};
    for (const [key, v] of Object.entries(inRatings)) {
      ratings[key] = Number.isFinite(v) ? Math.min(valueMax, Math.max(0, Math.round(Number(v)))) : null;
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
    scale: fileScale,
    // У старых файлов поля нет — тогда остаётся фон, выбранный в браузере.
    backdrop: data.backdrop && typeof data.backdrop === "object" ? parseBackdrop(data.backdrop) : null,
    preset: normalizePreset(data.preset),
    photos,
  };
}

// Категории, которых нет в загружаемом файле, — по ним оценки останутся пустыми.
// Если файл несёт свой пресет, предупреждение строится относительно него.
function missingCategories(session) {
  const known = new Set(Array.isArray(session.categories) ? session.categories : []);
  const expected = session.preset && session.preset.categories.length
    ? session.preset.categories
    : activeCategories();
  return expected.filter((cat) => !known.has(cat.key)).map((cat) => cat.label);
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
  const settingsParts = [];
  if (session.preset) settingsParts.push(`пресет «${escapeAttr(session.preset.label)}»`);
  if (session.scale) settingsParts.push(`шкала ${session.scale}`);
  if (session.backdrop) settingsParts.push(`фон фото «${escapeAttr(backdropLabel(session.backdrop))}»`);
  const settingsHint = settingsParts.length
    ? `<p class="muted" style="margin-top:8px">Из файла будут применены: <b>${settingsParts.join(", ")}</b>. Пресет будет доступен в настройках.</p>`
    : "";
  els.importPreview.innerHTML = `
    <p class="muted">Сессия от <b>${formatSessionDate(session.date)}</b></p>
    <p>Фото в файле: <b>${total}</b>${rated !== total ? ` (оценено ${rated}, пропущено ${skipped})` : ""}</p>
    ${sample ? `<p class="muted" style="margin-top:8px">Например: ${sample}${total > 4 ? "…" : ""}</p>` : ""}
    <p class="muted" style="margin-top:8px">${previewHint}</p>
    ${settingsHint}
    ${missingHint}
    <p class="muted" style="margin-top:8px">Сразу откроется таблица лидеров.</p>
  `;
  if (typeof els.importDialog.showModal === "function") els.importDialog.showModal();
  else showToast(`Импорт: ${total} фото`);
}

function loadImportedSession(session) {
  if (typeof els.importDialog.close === "function") els.importDialog.close();

  // Восстанавливаем пресет и шкалу, с которыми сохранялись оценки, чтобы
  // баллы отображались в тех же категориях.
  const willRebuild = applyImportedSettings(session);

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
  if (willRebuild) rebuildSettingsDependentUI(false);
  if (merged.matchedCount) {
    showToast(`Подключены локальные файлы: ${merged.matchedCount} из ${session.photos.length}`);
  }
  // Импортированные данные показываем сразу, без экрана оценки и тейбрейкера.
  openLeaderboard();
}

// Применяет пресет/шкалу из файла оценок. Возвращает true, если что-то поменялось.
function applyImportedSettings(session) {
  let changed = false;
  // Фон не влияет на оценки, поэтому применяется молча и не требует
  // перестройки интерфейса — контролы сами подпишутся на изменение.
  if (session.backdrop) setBackdrop(session.backdrop);
  if (session.scale && session.scale !== getScale()) {
    setScale(session.scale);
    changed = true;
  }
  if (session.preset) {
    const builtin = BUILTIN_PRESETS.find((p) => p.id === session.preset.id);
    if (builtin) {
      if (activePreset().id !== builtin.id) {
        setActivePresetId(builtin.id);
        changed = true;
      }
    } else {
      const preset = { ...session.preset };
      const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id));
      if (!preset.id || builtinIds.has(preset.id)) {
        preset.id = `custom-${Date.now().toString(36)}`;
      }
      const stored = saveCustomPreset(preset);
      if (activePreset().id !== stored.id) {
        setActivePresetId(stored.id);
        changed = true;
      }
    }
  }
  return changed;
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
  return Math.min(getScale(), Math.max(1, value));
}

function updateCategoryFilter(key, value) {
  const number = Number(value);
  const max = getScale();
  state.filters.min[key] = Number.isFinite(number) ? Math.min(max, Math.max(0, number)) : 0;
  renderTableOnly();
}

// --- Настройки: пресеты категорий и шкала оценки ---

let presetEditId = null; // id редактируемого пользовательского пресета
let presetEditOrig = []; // исходные категории при редактировании (для сохранения ключей)
let confirmResolver = null;

function hasRatedPhotos() {
  return state.photos.some(
    (photo) => photo.skipped || Object.values(photo.ratings || {}).some((value) => value != null),
  );
}

// Очищает все оценки сессии (при смене пресета/шкалы баллы несовместимы).
function clearSessionRatings() {
  for (const photo of state.photos) {
    photo.ratings = emptyRatings();
    photo.skipped = false;
    photo.thumb = null;
  }
  state.tiebreak = null;
}

function openConfirmDialog(title, text, okLabel) {
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.confirmOk.textContent = okLabel;
  if (typeof els.confirmDialog.showModal === "function") els.confirmDialog.showModal();
  else resolveConfirm(true); // диалогов нет — действуем сразу
}

function resolveConfirm(value) {
  // Сбрасываем резолвер до close(): закрытие диалога синхронно порождает
  // событие close, чей обработчик завершает ожидающий askConfirm значением
  // false — иначе подтверждение по кнопке «ОК» терялось бы.
  const resolve = confirmResolver;
  confirmResolver = null;
  if (typeof els.confirmDialog.close === "function" && els.confirmDialog.open) els.confirmDialog.close();
  if (resolve) resolve(value);
}

function askConfirm(title, text, okLabel) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    openConfirmDialog(title, text, okLabel);
  });
}

// Перестраивает всё, что зависит от пресета/шкалы, и приводит панель настроек
// в соответствие с активным состоянием. Оценки не трогает.
function rebuildSettingsDependentUI() {
  buildSettingsPresetOptions();
  buildRateKicker();
  buildCategories();
  buildSortOptions();
  buildCategoryFilters();
  buildTableHead();
  syncScoreFilterAttrs();
  resetBoardFilters();
  refreshSettingsPanel();
}

// Применяет уже изменённые настройки: чистит оценки, перестраивает экраны.
function finalizeSettingsChange() {
  clearSessionRatings();
  rebuildSettingsDependentUI();
  showToast("Настройки применены");
  if (state.screen === "rate") refreshRatePanel();
  else if (state.screen === "board") void renderLeaderboard();
}

function requestPresetChange(presetId) {
  const preset = listPresets().find((p) => p.id === presetId);
  if (!preset || presetId === activePreset().id) {
    refreshSettingsPanel();
    return;
  }
  const apply = () => {
    setActivePresetId(presetId);
    finalizeSettingsChange();
  };
  if (!hasRatedPhotos()) {
    apply();
    return;
  }
  void askConfirm(
    "Сменить пресет?",
    `Будет применён пресет «${preset.label}». Выставленные оценки текущей сессии будут очищены.`,
    "Очистить и применить",
  ).then((ok) => {
    if (ok) apply();
    else refreshSettingsPanel();
  });
}

function requestScaleChange(scale) {
  const option = SCALES.find((s) => s.value === scale);
  if (!option || scale === getScale()) {
    refreshSettingsPanel();
    return;
  }
  const apply = () => {
    setScale(scale);
    finalizeSettingsChange();
  };
  if (!hasRatedPhotos()) {
    apply();
    return;
  }
  void askConfirm(
    "Сменить шкалу?",
    `Оценки будут выставляться по ${option.label.toLowerCase()} шкале. Выставленные оценки текущей сессии будут очищены.`,
    "Очистить и применить",
  ).then((ok) => {
    if (ok) apply();
    else refreshSettingsPanel();
  });
}

function requestResetSettings() {
  const apply = () => {
    resetSettings();
    finalizeSettingsChange();
  };
  if (!hasRatedPhotos()) {
    apply();
    return;
  }
  void askConfirm(
    "Сбросить настройки?",
    "Будут восстановлены пресет «Человек» и 10-балльная шкала. Оценки текущей сессии будут очищены.",
    "Сбросить и применить",
  ).then((ok) => {
    if (ok) apply();
    else refreshSettingsPanel();
  });
}

function buildSettingsPresetOptions() {
  const presets = listPresets();
  const fragment = document.createDocumentFragment();
  const groups = [
    { label: "Встроенные", items: presets.filter((p) => p.builtin) },
    { label: "Мои пресеты", items: presets.filter((p) => !p.builtin) },
  ];
  for (const group of groups) {
    if (!group.items.length) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const preset of group.items) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      optgroup.append(option);
    }
    fragment.append(optgroup);
  }
  els.settingsPreset.replaceChildren(fragment);
}

function buildSettingsScaleChoices() {
  els.settingsScale.replaceChildren(
    ...SCALES.map((scale) => {
      const label = document.createElement("label");
      label.className = "scale-choice";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "settings-scale";
      radio.value = String(scale.value);

      const dot = document.createElement("span");
      dot.className = "scale-radio";

      const txt = document.createElement("span");
      txt.className = "scale-txt";
      const b = document.createElement("b");
      b.textContent = `${scale.value}-балльная`;
      const i = document.createElement("i");
      i.textContent = scale.caption;
      txt.append(b, i);

      label.append(radio, dot, txt);
      return label;
    }),
  );
}

function renderPresetCats() {
  const preset = activePreset();
  els.settingsPresetCats.replaceChildren(
    ...preset.categories.map((cat, index) => {
      const chip = document.createElement("div");
      chip.className = "preset-cat-chip";
      const swatch = document.createElement("i");
      swatch.className = "swatch";
      swatch.style.background = catColor(index);
      const text = document.createElement("span");
      text.textContent = cat.label;
      chip.append(swatch, text);
      return chip;
    }),
  );
}

function refreshSettingsPanel() {
  const preset = activePreset();
  els.settingsPreset.value = preset.id;
  for (const radio of els.settingsScale.querySelectorAll('input[name="settings-scale"]')) {
    radio.checked = Number(radio.value) === getScale();
  }
  renderPresetCats();
  const custom = !preset.builtin;
  els.btnPresetEdit.hidden = !custom;
  els.btnPresetDownload.hidden = !custom;
  els.btnPresetDelete.hidden = !custom;
}

// --- Редактор пользовательских пресетов ---

function presetRowElement(cat) {
  const row = document.createElement("div");
  row.className = "preset-cat-row";

  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 40;
  input.placeholder = "Название категории";
  input.autocomplete = "off";
  input.value = cat ? cat.label : "";
  if (cat) row.dataset.key = cat.key;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn";
  remove.setAttribute("aria-label", "Убрать категорию");
  remove.title = "Убрать";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    row.remove();
    if (!els.presetCatEditor.children.length) addPresetRow();
  });

  row.append(input, remove);
  return row;
}

function addPresetRow() {
  els.presetCatEditor.append(presetRowElement(null));
}

function openPresetEditor(preset) {
  presetEditId = preset && !preset.builtin ? preset.id : null;
  presetEditOrig = preset ? preset.categories : [];
  els.presetDialogTitle.textContent = presetEditId ? "Изменить пресет" : "Новый пресет";
  els.btnPresetSave.textContent = presetEditId ? "Сохранить пресет" : "Создать пресет";
  els.presetName.value = preset ? preset.label : "";
  els.presetCatEditor.replaceChildren();
  const start = presetEditOrig.length ? presetEditOrig : [null];
  for (const cat of start) els.presetCatEditor.append(presetRowElement(cat));
  if (typeof els.presetDialog.showModal === "function") {
    els.presetDialog.showModal();
    els.presetName.focus();
  }
}

function collectPresetEditorRows() {
  const rows = [...els.presetCatEditor.querySelectorAll(".preset-cat-row")];
  const usedKeys = new Set();
  const categories = [];
  for (const row of rows) {
    const label = row.querySelector("input").value.trim();
    if (!label) continue;
    let key = row.dataset.key || "";
    if (!key || usedKeys.has(key)) key = makeCategoryKey(label, usedKeys);
    usedKeys.add(key);
    categories.push({ key, label });
  }
  return categories;
}

// true, если два набора категорий совпадают по ключам и порядку
// (переименование категории ключ сохраняет — оценки остаются валидными).
function sameCategoryShape(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false;
  return before.every((cat, index) => {
    const key = cat && cat.key ? String(cat.key) : "";
    const other = after[index];
    return Boolean(key) && other && String(other.key || "") === key;
  });
}

function submitPresetForm() {
  const label = els.presetName.value.trim();
  if (!label) {
    els.presetName.focus();
    showToast("Укажите название пресета");
    return;
  }
  const categories = collectPresetEditorRows();
  if (!categories.length) {
    showToast("Добавьте хотя бы одну категорию");
    return;
  }
  // Правка пресета, который сейчас активен: при изменении набора категорий
  // оценки сессии становятся несовместимыми — ведём себя как при смене пресета.
  const editingActive = Boolean(presetEditId) && activePreset().id === presetEditId;
  const shapeChanged = editingActive && !sameCategoryShape(presetEditOrig, categories);
  const preset = saveCustomPreset({
    id: presetEditId || `custom-${Date.now().toString(36)}`,
    label,
    categories,
  });
  if (typeof els.presetDialog.close === "function") els.presetDialog.close();
  presetEditId = null;
  presetEditOrig = [];

  if (editingActive && shapeChanged) {
    const apply = () => {
      finalizeSettingsChange();
      showToast("Пресет обновлён");
    };
    if (!hasRatedPhotos()) {
      apply();
      return;
    }
    void askConfirm(
      "Сменить пресет?",
      `Пресет «${preset.label}» изменён. Выставленные оценки текущей сессии будут очищены.`,
      "Очистить и применить",
    ).then((ok) => {
      if (ok) apply();
      else refreshSettingsPanel();
    });
    return;
  }

  if (editingActive) {
    // Набор категорий прежний (например, переименование) — оценки сохраняются,
    // обновляем все экраны под новые названия.
    rebuildSettingsDependentUI();
    showToast("Пресет обновлён");
    if (state.screen === "rate") refreshRatePanel();
    else if (state.screen === "board") void renderLeaderboard();
    return;
  }

  requestPresetChange(preset.id);
}

function downloadPreset(preset) {
  const blob = new Blob([serializePreset(preset)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const slug = categorySlug(preset.label).replace(/-+$/g, "") || "preset";
  a.href = url;
  a.download = `photovote-preset-${slug}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast("Пресет сохранён в JSON");
}

async function handlePresetFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    showToast("Не удалось прочитать файл пресета");
    return;
  }
  const preset = parsePresetFile(text);
  if (!preset) {
    showToast("Файл не похож на пресет категорий");
    return;
  }
  const taken = new Set(listPresets().map((p) => p.id));
  if (!preset.id || taken.has(preset.id)) {
    // Не затираем существующий пресет с тем же id — создаём новую копию.
    preset.id = `custom-${Date.now().toString(36)}`;
  }
  saveCustomPreset(preset);
  buildSettingsPresetOptions();
  showToast(`Пресет «${preset.label}» загружен`);
  requestPresetChange(preset.id);
}

function bindSettings() {
  buildSettingsPresetOptions();
  buildSettingsScaleChoices();
  refreshSettingsPanel();

  els.settingsPreset.addEventListener("change", () => requestPresetChange(els.settingsPreset.value));
  els.settingsScale.addEventListener("change", (event) => {
    const value = Number(event.target.value);
    if (event.target.type === "radio" && Number.isFinite(value)) requestScaleChange(value);
  });
  els.btnPresetNew.addEventListener("click", () => openPresetEditor(null));
  els.btnPresetEdit.addEventListener("click", () => openPresetEditor(activePreset()));
  els.btnPresetDownload.addEventListener("click", () => downloadPreset(activePreset()));
  els.btnPresetDelete.addEventListener("click", () => {
    const preset = activePreset();
    if (!preset || preset.builtin) return;
    void askConfirm(
      "Удалить пресет?",
      `Пресет «${preset.label}» будет удалён из этого браузера. Если он использовался, будет применён пресет «Человек».`,
      "Удалить",
    ).then((ok) => {
      if (!ok) return;
      deleteCustomPreset(preset.id);
      const fallback = BUILTIN_PRESETS[0];
      if (activePreset().id === preset.id) setActivePresetId(fallback.id);
      rebuildSettingsDependentUI();
      showToast("Пресет удалён");
    });
  });
  els.btnPresetUpload.addEventListener("click", () => els.inputPreset.click());
  els.inputPreset.addEventListener("change", async () => {
    const file = els.inputPreset.files?.[0];
    els.inputPreset.value = "";
    if (file) await handlePresetFile(file);
  });
  els.btnSettingsReset.addEventListener("click", requestResetSettings);

  // Диалог подтверждения
  els.confirmOk.addEventListener("click", () => resolveConfirm(true));
  els.confirmCancel.addEventListener("click", () => resolveConfirm(false));
  els.confirmDialog.addEventListener("close", () => {
    if (confirmResolver) resolveConfirm(false);
  });
  els.confirmDialog.addEventListener("click", (event) => {
    if (event.target === els.confirmDialog) resolveConfirm(false);
  });

  // Диалог редактора пресета
  els.presetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitPresetForm();
  });
  els.btnPresetCancel.addEventListener("click", () => {
    if (typeof els.presetDialog.close === "function") els.presetDialog.close();
    presetEditId = null;
    presetEditOrig = [];
  });
  els.btnCatAdd.addEventListener("click", addPresetRow);
  els.presetDialog.addEventListener("click", (event) => {
    if (event.target === els.presetDialog && typeof els.presetDialog.close === "function") {
      els.presetDialog.close();
      presetEditId = null;
      presetEditOrig = [];
    }
  });
}

// --- Фон оцениваемого фото ---

// Кнопка в тулбаре показывает текущий фон: цвет (или градиент темы) в превью
// и название режима в подписи/подсказке.
function refreshBackdropTrigger() {
  const backdrop = getBackdrop();
  const label = backdropLabel(backdrop);
  els.backdropSwatch.style.background = backdropCssValue(backdrop);
  els.backdropSwatch.classList.toggle("is-light", backdropTone(backdrop) === "light");
  els.btnBackdrop.title = `Фон фото: ${label}`;
  els.btnBackdrop.setAttribute("aria-label", `Фон фото: ${label}. Открыть выбор фона`);
  els.backdropValue.textContent = label;
}

/**
 * Открывает/закрывает поповер выбора фона.
 *
 * @param {boolean} open
 * @param {{restoreFocus?: boolean}} [options] restoreFocus=false — не возвращать
 *   фокус на кнопку (используется при закрытии кликом мимо: пользователь
 *   намеренно работал с другим элементом страницы).
 */
function setBackdropPopover(open, options = {}) {
  const next = !!open;
  if (next === backdropPopoverOpen) return;
  backdropPopoverOpen = next;
  els.backdropPopover.hidden = !next;
  els.btnBackdrop.setAttribute("aria-expanded", String(next));
  if (next) {
    // На всякий случай синхронизируем содержимое с текущим состоянием.
    backdropPopoverControl?.refresh();
    return;
  }
  // Фокус не должен оставаться в скрытом поповере.
  const active = document.activeElement;
  if (!(active instanceof Element) || !els.backdropPopover.contains(active)) return;
  if (options.restoreFocus === false) active.blur();
  else els.btnBackdrop.focus();
}

function bindBackdrop() {
  // Один и тот же компонент в двух местах: настройки слева и поповер у фото.
  createBackdropControl(els.settingsBackdrop, { label: "Фон оцениваемого фото" });
  backdropPopoverControl = createBackdropControl(els.backdropPopoverBody, {
    variant: "popover",
    label: "Фон оцениваемого фото",
  });

  subscribeBackdrop(refreshBackdropTrigger);
  refreshBackdropTrigger();

  els.btnBackdrop.addEventListener("click", () => setBackdropPopover(!backdropPopoverOpen));
  els.btnBackdropClose.addEventListener("click", () => setBackdropPopover(false));

  // Клик вне поповера и Escape закрывают его.
  document.addEventListener("pointerdown", (event) => {
    if (!backdropPopoverOpen) return;
    if (els.backdropWrap.contains(event.target)) return;
    setBackdropPopover(false, { restoreFocus: false });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !backdropPopoverOpen) return;
    setBackdropPopover(false);
  });
}

function bindRate() {
  // Всё, что зависит от набора категорий, строится из активного пресета.
  buildRateKicker();
  buildCategories();
  buildSortOptions();
  buildCategoryFilters();
  buildTableHead();
  syncScoreFilterAttrs();
  bindSettings();
  bindBackdrop();
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
    // В полях ввода (HEX-код фона, название пресета, ползунки HSV) клавиши
    // принадлежат полю: иначе «s» пропускало бы фото, а стрелки — листали их.
    const typed = event.target;
    if (typed instanceof Element && typed.closest("input, textarea, select, [contenteditable]")) return;
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
