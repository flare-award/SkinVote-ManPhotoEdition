// Единый источник правды для категорий оценки.
//
// Категории больше не фиксированы: они задаются «пресетом» (набор категорий),
// а оценка идёт по одной из шкал (5 / 10 / 100).
//
//   • Встроенные пресеты — «Человек» и «Логотип TFSM».
//   • Пользовательские пресеты хранятся локально (localStorage) и могут быть
//     скачаны в файл и загружены обратно в любой момент.
//   • Активные настройки (пресет + шкала) тоже хранятся локально и применяются
//     с первого же экрана. По умолчанию: пресет «Человек», шкала 10.
//
// Карточки рейтинга, сортировка таблицы лидеров, фильтры, шапка таблицы,
// разбивка в детальном просмотре, экспорт и импорт — всё строится из
// активного набора категорий, поэтому смена пресета/шкалы перестраивает
// интерфейс на лету.

export const BUILTIN_PRESETS = [
  {
    id: "human",
    label: "Человек",
    builtin: true,
    categories: [
      { key: "hairstyle", label: "Причёска" },
      { key: "eyeColor", label: "Цвет глаз" },
      { key: "topClothes", label: "Верхняя одежда" },
      { key: "bottomClothes", label: "Нижняя одежда" },
      { key: "shoes", label: "Обувь" },
      { key: "accessories", label: "Аксессуары" },
    ],
  },
  {
    id: "tfsm-logo",
    label: "Логотип TFSM",
    builtin: true,
    categories: [
      { key: "tfColor", label: "Цвет TF" },
      { key: "tfStyle", label: "Стиль TF" },
      { key: "smStyle", label: "Стиль SM" },
      { key: "readability", label: "Читаемость" },
      { key: "combination", label: "Сочетание" },
    ],
  },
];

export const DEFAULT_PRESET_ID = "human";

// Доступные шкалы оценки. value — максимум балла.
export const SCALES = [
  { value: 5, label: "5-балльная", caption: "кружки 1–5" },
  { value: 10, label: "10-балльная", caption: "кружки 1–10" },
  { value: 100, label: "100-балльная", caption: "число, шаг ±10" },
];
export const DEFAULT_SCALE = 10;

const SETTINGS_KEY = "photovote.settings.v1";
const CUSTOM_PRESETS_KEY = "photovote.customPresets.v1";

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJson(key) {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Переполнение / приватный режим — настройки просто не сохранятся.
  }
}

// --- Пользовательские пресеты ---

export function listCustomPresets() {
  const list = readJson(CUSTOM_PRESETS_KEY);
  return Array.isArray(list) ? list : [];
}

// Пресет, «собранный» по данным пользователя (порядок категорий сохраняется).
function buildPresetRecord(preset) {
  return {
    id: String(preset.id),
    label: String(preset.label || "Без названия"),
    builtin: false,
    categories: (Array.isArray(preset.categories) ? preset.categories : [])
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        key: String(c.key || ""),
        label: String(c.label || "Без названия"),
      })),
  };
}

// Сохраняет (добавляет или обновляет по id) пользовательский пресет.
export function saveCustomPreset(preset) {
  const record = buildPresetRecord(preset);
  const list = listCustomPresets().filter((p) => p.id !== record.id);
  list.push(record);
  writeJson(CUSTOM_PRESETS_KEY, list);
  return record;
}

export function deleteCustomPreset(id) {
  writeJson(
    CUSTOM_PRESETS_KEY,
    listCustomPresets().filter((p) => p.id !== id),
  );
}

// Все пресеты: встроенные + пользовательские.
export function listPresets() {
  return [...BUILTIN_PRESETS, ...listCustomPresets()];
}

// --- Активные настройки (пресет + шкала) ---

function defaultSettings() {
  return { presetId: DEFAULT_PRESET_ID, scale: DEFAULT_SCALE };
}

function sanitizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  const presets = listPresets();
  const presetId = presets.some((p) => p.id === raw.presetId) ? raw.presetId : base.presetId;
  const scale = SCALES.some((s) => s.value === raw.scale) ? raw.scale : base.scale;
  return { presetId, scale };
}

let settings = sanitizeSettings(readJson(SETTINGS_KEY));

function persist() {
  writeJson(SETTINGS_KEY, settings);
}

export function getSettings() {
  return settings;
}

export function getScale() {
  return settings.scale;
}

// Меняет шкалу оценки (5 / 10 / 100).
export function setScale(scale) {
  if (!SCALES.some((s) => s.value === scale)) return;
  settings = { ...settings, scale };
  persist();
}

// Активирует пресет по id (встроенный или пользовательский).
export function setActivePresetId(presetId) {
  if (!listPresets().some((p) => p.id === presetId)) return;
  settings = { ...settings, presetId };
  persist();
}

export function setSettings(next) {
  settings = sanitizeSettings(next);
  persist();
}

export function resetSettings() {
  settings = defaultSettings();
  persist();
}

export function activePreset() {
  return listPresets().find((p) => p.id === settings.presetId) || BUILTIN_PRESETS[0];
}

export function activeCategories() {
  return activePreset().categories;
}

export function activeCategoryKeys() {
  return activeCategories().map((cat) => cat.key);
}

// Категория по ключу — ищется в активном пресете, затем во всех остальных.
export function categoryLabel(key) {
  for (const preset of listPresets()) {
    const found = preset.categories.find((cat) => cat.key === key);
    if (found) return found.label;
  }
  return key;
}

// Пустой набор оценок: у нового фото каждая категория ещё не оценена.
// Ключи берутся из активного пресета на момент вызова.
export function emptyRatings(value = null) {
  return Object.fromEntries(activeCategoryKeys().map((key) => [key, value]));
}

// «1 категория», «2 категории», «7 категорий».
export function pluralCategories(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "категория";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "категории";
  return "категорий";
}

// Ключ -> css-класс/id в kebab-case (например, topClothes -> top-clothes).
export function categorySlug(key) {
  return String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

// Безопасный ключ для новой пользовательской категории: латиница, цифры, - и _.
// Если из метки не получается ключ — добавляется случайный суффикс, чтобы
// ключи внутри пресета гарантированно не совпадали.
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y",
  ь: "", э: "e", ю: "yu", я: "ya",
};

export function makeCategoryKey(label, existingKeys) {
  const taken = new Set(existingKeys);
  let base = String(label || "")
    .toLowerCase()
    .split("")
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (!base) base = "cat";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}-${n++}`;
  return key;
}

// --- Экспорт пресета в файл / разбор файла пресета ---

export function serializePreset(preset) {
  return JSON.stringify(
    {
      app: "photovote",
      type: "preset",
      version: 1,
      preset: buildPresetRecord(preset),
    },
    null,
    2,
  );
}

// Разбирает JSON-файл пресета. Возвращает null, если файл не похож на пресет.
export function parsePresetFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = data && typeof data === "object" ? data.preset || data : null;
  if (!raw || !Array.isArray(raw.categories) || raw.categories.length === 0) return null;
  const categories = raw.categories
    .filter((c) => c && typeof c === "object" && String(c.label || "").trim())
    .map((c) => ({ key: String(c.key || ""), label: String(c.label).trim() }));
  if (!categories.length) return null;
  const used = new Set();
  for (const cat of categories) {
    if (!cat.key || used.has(cat.key)) {
      cat.key = makeCategoryKey(cat.label, used);
    }
    used.add(cat.key);
  }
  return {
    id: String(raw.id || ""),
    label: String(raw.label || "Мой пресет").trim() || "Мой пресет",
    categories,
  };
}
