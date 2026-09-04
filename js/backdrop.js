// Фон сцены просмотра фото — подложка, на которой лежит оцениваемое изображение.
//
// Режимы:
//   • default — штатный градиент темы (как было до появления настройки);
//   • white   — чисто белый фон;
//   • black   — чисто чёрный фон;
//   • custom  — свой цвет: выбирается системной пипеткой, ползунками HSV
//               или вводом HEX-кода, применяется мгновенно.
//
// Состояние одно на всё приложение: оно хранится в localStorage и применяется
// ко всем сценам просмотра (оценка, тейбрейкер, детальный просмотр) через
// CSS-переменную --stage-bg на <html>. В режиме default переменная снимается,
// и каждая сцена показывает свой прежний градиент из css/app.css — так фон по
// умолчанию остаётся ровно таким же, каким был.
//
// Модуль не знает про разметку: он лишь хранит состояние, красит <html> и
// рассылает подписчикам уведомления. Интерфейс строит js/backdrop-ui.js.

export const BACKDROP_MODES = [
  { id: "default", label: "По умолчанию", caption: "градиент темы" },
  { id: "white", label: "Белый", caption: "#FFFFFF" },
  { id: "black", label: "Чёрный", caption: "#000000" },
  { id: "custom", label: "Свой цвет", caption: "пипетка · HSV · HEX" },
];

export const DEFAULT_BACKDROP_MODE = "default";

// Стартовый цвет режима «Свой цвет» — нейтральный серый, на нём удобно
// проверять и тёмные, и светлые фото.
export const DEFAULT_CUSTOM_COLOR = "#808080";

// Градиент темы: используется как превью в настройках (в режиме default
// сцены берут свой фон из CSS, переменная --stage-bg не выставляется).
const DEFAULT_STAGE_BG = "radial-gradient(ellipse at 50% 38%, #2a2d3f 0%, #14151c 68%)";

// Быстрые цвета: нейтральные подложки для проверки фото и акценты темы.
export const BACKDROP_QUICK_COLORS = [
  { hex: "#ffffff", title: "Белый" },
  { hex: "#000000", title: "Чёрный" },
  { hex: "#808080", title: "Средне-серый" },
  { hex: "#bfbfbf", title: "Светло-серый" },
  { hex: "#2b2d3a", title: "Графит" },
  { hex: "#00b140", title: "Хромакей" },
  { hex: "#6cb6ff", title: "Синий" },
  { hex: "#e8c36a", title: "Золотой" },
  { hex: "#ff8b7a", title: "Коралловый" },
  { hex: "#7ee0c4", title: "Мятный" },
];

const STORAGE_KEY = "photovote.backdrop.v1";
// Порог яркости: выше — фон считается светлым, и подписи поверх него
// переключаются на тёмные (см. [data-stage-tone] в css/app.css).
const LIGHT_TONE_THRESHOLD = 0.4;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function clampChannel(value) {
  const num = Number(value);
  return Math.round(clamp(Number.isFinite(num) ? num : 0, 0, 255));
}

// --- Цвет: HEX <-> RGB <-> HSV ---

/**
 * Приводит строку к каноническому `#rrggbb`.
 * Понимает `#rgb`, `rgb`, `#rrggbb`, `rrggbb` (регистр и пробелы не важны).
 * Всё остальное — в том числе неполный ввод вроде `#12` — даёт null.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeHex(value) {
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(text)) {
    text = text
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return `#${text.toLowerCase()}`;
}

export function hexToRgb(hex) {
  const normalized = normalizeHex(hex) || "#000000";
  const int = Number.parseInt(normalized.slice(1), 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

export function rgbToHex(rgb) {
  const part = (value) => clampChannel(value).toString(16).padStart(2, "0");
  return `#${part(rgb?.r)}${part(rgb?.g)}${part(rgb?.b)}`;
}

/** RGB -> HSV: h 0..360, s 0..100, v 0..100. */
export function rgbToHsv(rgb) {
  const r = clampChannel(rgb?.r) / 255;
  const g = clampChannel(rgb?.g) / 255;
  const b = clampChannel(rgb?.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max > 0 ? (delta / max) * 100 : 0, v: max * 100 };
}

/** HSV -> RGB: h любой (нормализуется по модулю 360), s и v 0..100. */
export function hsvToRgb(hsv) {
  const h = Number(hsv?.h);
  const hue = (((Number.isFinite(h) ? h : 0) % 360) + 360) % 360;
  const s = clamp(Number(hsv?.s) || 0, 0, 100) / 100;
  const v = clamp(Number(hsv?.v) || 0, 0, 100) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  const sector = Math.floor(hue / 60) % 6;
  const [r1, g1, b1] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector];
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

export function hexToHsv(hex) {
  return rgbToHsv(hexToRgb(hex));
}

export function hsvToHex(hsv) {
  return rgbToHex(hsvToRgb(hsv));
}

/** Относительная яркость (0..1) по WCAG — для выбора контрастных подписей. */
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function isLightHex(hex) {
  return luminance(hex) > LIGHT_TONE_THRESHOLD;
}

// --- Состояние ---

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStored() {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persist(value) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Приватный режим или переполнение — фон просто не запомнится.
  }
}

/** Приводит произвольные данные (в т. ч. из JSON-сессии) к валидному состоянию. */
export function parseBackdrop(raw) {
  const mode = BACKDROP_MODES.some((item) => item.id === raw?.mode)
    ? String(raw.mode)
    : DEFAULT_BACKDROP_MODE;
  const color = normalizeHex(raw?.color) || DEFAULT_CUSTOM_COLOR;
  return { mode, color };
}

let state = parseBackdrop(readStored());
const listeners = new Set();

/** @returns {{mode: string, color: string}} копия текущего состояния. */
export function getBackdrop() {
  return { ...state };
}

/**
 * CSS-значение подложки для текущего режима.
 * В режиме default возвращается градиент темы — удобно для превью в настройках.
 */
export function backdropCssValue(backdrop = state) {
  const { mode, color } = parseBackdrop(backdrop);
  switch (mode) {
    case "white":
      return "#ffffff";
    case "black":
      return "#000000";
    case "custom":
      return color;
    default:
      return DEFAULT_STAGE_BG;
  }
}

/** `light` | `dark` — тон подложки, от него зависят подписи поверх сцены. */
export function backdropTone(backdrop = state) {
  const { mode, color } = parseBackdrop(backdrop);
  if (mode === "default") return "dark";
  return isLightHex(backdropCssValue({ mode, color })) ? "light" : "dark";
}

/** Короткое человекочитаемое название текущего фона («Чёрный», «#808080»). */
export function backdropLabel(backdrop = state) {
  const { mode, color } = parseBackdrop(backdrop);
  if (mode === "custom") return color.toUpperCase();
  const option = BACKDROP_MODES.find((item) => item.id === mode);
  return option ? option.label : "По умолчанию";
}

function applyToDocument() {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  if (!root) return;
  if (state.mode === "default") {
    // Сцены берут свой градиент из CSS (fallback у var(--stage-bg, …)).
    root.style.removeProperty("--stage-bg");
  } else {
    root.style.setProperty("--stage-bg", backdropCssValue(state));
  }
  root.dataset.stageTone = backdropTone(state);
}

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener(getBackdrop());
    } catch {
      // Сбой одного подписчика не должен ломать остальные.
    }
  }
}

function commit(next) {
  const sanitized = parseBackdrop(next);
  const unchanged = sanitized.mode === state.mode && sanitized.color === state.color;
  state = sanitized;
  if (unchanged) return false;
  persist(state);
  applyToDocument();
  emit();
  return true;
}

/** Переключает режим фона (default / white / black / custom). */
export function setBackdropMode(mode) {
  if (!BACKDROP_MODES.some((item) => item.id === mode)) return false;
  return commit({ ...state, mode });
}

/**
 * Задаёт свой цвет и заодно включает режим «Свой цвет»: сам факт выбора цвета
 * в пипетке или ползунком — уже намерение уйти от стандартной подложки.
 *
 * @param {string} hex
 * @returns {boolean} true, если значение принято и фон изменился.
 */
export function setBackdropColor(hex) {
  const color = normalizeHex(hex);
  if (!color) return false;
  return commit({ mode: "custom", color });
}

/** Полная замена состояния (например, настройками из импортированного файла). */
export function setBackdrop(next) {
  return commit(next);
}

/**
 * Подписка на изменения фона.
 * @param {(backdrop: {mode: string, color: string}) => void} listener
 * @returns {() => void} отписка
 */
export function subscribeBackdrop(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Синхронизация между вкладками: поменяли фон в одной — подхватили в другой.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    let raw = null;
    try {
      raw = event.newValue ? JSON.parse(event.newValue) : null;
    } catch {
      return;
    }
    commit(raw);
  });
}

// Красим документ сразу при загрузке, чтобы сохранённый фон появился
// вместе с первым же показанным фото.
applyToDocument();
