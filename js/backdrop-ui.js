// Элемент управления фоном фото: четыре режима + редактор своего цвета.
//
// Один и тот же компонент используется в двух местах:
//   • панель настроек на экране оценки (постоянно видимый);
//   • поповер кнопки «Фон» в тулбаре окна просмотра (быстрое переключение).
//
// Обе копии читают и пишут общее состояние (js/backdrop.js) и перерисовываются
// по подписке, поэтому расхождение между ними невозможно.
//
// Редактор своего цвета:
//   • системная пипетка <input type="color">;
//   • ползунки HSV (оттенок / насыщенность / яркость) с живыми градиентами;
//   • поле HEX-кода (принимает #rgb, rgb, #rrggbb, rrggbb);
//   • быстрые цвета — нейтральные подложки и акценты темы.
// Любое изменение применяется к фону мгновенно, без кнопок «Применить».

import {
  BACKDROP_MODES,
  BACKDROP_QUICK_COLORS,
  DEFAULT_CUSTOM_COLOR,
  backdropCssValue,
  getBackdrop,
  hexToHsv,
  hsvToHex,
  isLightHex,
  normalizeHex,
  setBackdropColor,
  setBackdropMode,
  subscribeBackdrop,
} from "./backdrop.js";

// Каналы HSV: подпись, подсказка, диапазон и единицы.
const CHANNELS = [
  { key: "h", label: "H", title: "Оттенок (hue)", min: 0, max: 360, unit: "°" },
  { key: "s", label: "S", title: "Насыщенность (saturation)", min: 0, max: 100, unit: "%" },
  { key: "v", label: "V", title: "Яркость (value)", min: 0, max: 100, unit: "%" },
];

// Градиент оттенков для ползунка H — он не зависит от текущего цвета.
const HUE_TRACK =
  "linear-gradient(90deg, #ff0000 0%, #ffff00 16.7%, #00ff00 33.3%, #00ffff 50%, " +
  "#0000ff 66.7%, #ff00ff 83.3%, #ff0000 100%)";

let instanceCounter = 0;

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * У серого (S = 0) и чёрного (V = 0) оттенок не определён: RGB -> HSV даёт H = 0.
 * Если не сохранять прежние значения, ползунок H «обнулится» и цвет после
 * возврата насыщенности станет красным. Поэтому берём H (а для чёрного и S)
 * из предыдущего состояния.
 */
function syncHsv(hex, previous) {
  const next = hexToHsv(hex);
  if (previous) {
    if (next.s < 0.5) next.h = previous.h;
    if (next.v < 0.5) {
      next.h = previous.h;
      next.s = previous.s;
    }
  }
  return next;
}

function trackFor(channel, hsv) {
  if (channel === "h") return HUE_TRACK;
  if (channel === "s") {
    const from = hsvToHex({ h: hsv.h, s: 0, v: hsv.v });
    const to = hsvToHex({ h: hsv.h, s: 100, v: hsv.v });
    return `linear-gradient(90deg, ${from} 0%, ${to} 100%)`;
  }
  const to = hsvToHex({ h: hsv.h, s: hsv.s, v: 100 });
  return `linear-gradient(90deg, #000000 0%, ${to} 100%)`;
}

function formatHex(hex) {
  const normalized = normalizeHex(hex) || DEFAULT_CUSTOM_COLOR;
  return `#${normalized.slice(1).toUpperCase()}`;
}

/**
 * Строит переключатель фона внутри `root` (содержимое заменяется).
 *
 * @param {HTMLElement} root контейнер для контрола.
 * @param {object} [options]
 * @param {"panel"|"popover"} [options.variant="panel"] влияет только на класс-модификатор.
 * @param {string} [options.label="Фон фото"] подпись для aria.
 * @returns {{element: HTMLElement, refresh: () => void, dispose: () => void}|null}
 */
export function createBackdropControl(root, options = {}) {
  if (!root) return null;
  const variant = options.variant === "popover" ? "popover" : "panel";
  const label = options.label || "Фон фото";
  instanceCounter += 1;
  const groupName = `backdrop-mode-${instanceCounter}`;

  root.classList.add("backdrop-control", `is-${variant}`);
  root.replaceChildren();

  const listeners = [];
  const on = (target, type, handler, opts) => {
    target.addEventListener(type, handler, opts);
    listeners.push([target, type, handler, opts]);
  };

  // --- локальное состояние редактора ---
  // HSV живёт здесь, а не выводится из HEX каждый раз: так ползунки не «дрожат»
  // из-за округления и не теряют оттенок на сером/чёрном.
  let hsv = syncHsv(getBackdrop().color, null);
  // Признак «изменение пришло из этого контрола» — подписка в таком случае
  // не перерисовывает поля, которые сейчас редактирует пользователь.
  let selfUpdate = false;

  // --- переключатель режимов ---
  const choices = makeElement("div", "bg-choices");
  choices.setAttribute("role", "radiogroup");
  choices.setAttribute("aria-label", label);

  const radios = new Map();
  const items = new Map();
  const swatches = new Map();
  const captions = new Map();

  for (const mode of BACKDROP_MODES) {
    const item = makeElement("label", "bg-choice");
    item.dataset.mode = mode.id;

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = groupName;
    radio.value = mode.id;

    const swatch = makeElement("span", "bg-swatch");
    swatch.setAttribute("aria-hidden", "true");

    const name = makeElement("b", "bg-choice-name", mode.label);
    // Подпись справа: у «Своего цвета» здесь живой HEX текущего фона.
    const caption = makeElement("i", "bg-choice-cap");

    item.append(radio, swatch, name, caption);
    choices.append(item);

    radios.set(mode.id, radio);
    items.set(mode.id, item);
    swatches.set(mode.id, swatch);
    captions.set(mode.id, caption);
  }

  // --- редактор своего цвета ---
  const editor = makeElement("div", "bg-editor");
  editor.hidden = true;

  const editorRow = makeElement("div", "bg-editor-row");

  const picker = makeElement("label", "bg-picker");
  picker.title = "Открыть системную палитру";
  const pickerInput = document.createElement("input");
  pickerInput.type = "color";
  pickerInput.value = DEFAULT_CUSTOM_COLOR;
  pickerInput.setAttribute("aria-label", "Системная палитра цвета фона");
  picker.append(pickerInput);

  const hexField = makeElement("label", "bg-hex");
  const hexCaption = makeElement("span", null, "HEX");
  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.maxLength = 7;
  hexInput.spellcheck = false;
  hexInput.autocomplete = "off";
  hexInput.placeholder = formatHex(DEFAULT_CUSTOM_COLOR);
  hexInput.setAttribute("aria-label", "HEX-код цвета фона");
  hexField.append(hexCaption, hexInput);

  const hexError = makeElement("p", "bg-hex-error", "Нужен HEX-код, например #4A7CFF");
  hexError.hidden = true;
  hexError.id = `bg-hex-error-${instanceCounter}`;
  hexInput.setAttribute("aria-describedby", hexError.id);

  editorRow.append(picker, hexField);

  const sliders = makeElement("div", "bg-sliders");
  const sliderInputs = new Map();
  const sliderValues = new Map();

  for (const channel of CHANNELS) {
    const row = makeElement("label", "bg-slider");
    row.dataset.channel = channel.key;

    const head = makeElement("span", "bg-slider-head");
    const name = makeElement("b", null, channel.label);
    name.title = channel.title;
    const value = makeElement("i", "bg-slider-value");
    head.append(name, value);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(channel.min);
    input.max = String(channel.max);
    input.step = "1";
    input.setAttribute("aria-label", channel.title);

    row.append(head, input);
    sliders.append(row);
    sliderInputs.set(channel.key, input);
    sliderValues.set(channel.key, value);
  }

  const quick = makeElement("div", "bg-quick");
  quick.setAttribute("role", "group");
  quick.setAttribute("aria-label", "Быстрые цвета фона");
  for (const swatch of BACKDROP_QUICK_COLORS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bg-quick-swatch";
    button.dataset.hex = swatch.hex;
    button.style.background = swatch.hex;
    button.title = `${swatch.title} · ${swatch.hex.toUpperCase()}`;
    button.setAttribute("aria-label", `Фон ${swatch.title}, ${swatch.hex.toUpperCase()}`);
    quick.append(button);
  }

  const note = makeElement(
    "p",
    "bg-note",
    "Фон меняется сразу и запоминается в этом браузере — оценки не сбрасываются.",
  );

  editor.append(editorRow, hexError, sliders, quick, note);
  root.append(choices, editor);

  // --- перерисовка ---
  // `source` — какой элемент сейчас редактируется: его значение не
  // перезаписываем, чтобы не мешать вводу и перетаскиванию.
  function render(source = null) {
    const { mode, color } = getBackdrop();
    const hexText = formatHex(color);
    const light = isLightHex(color);

    for (const option of BACKDROP_MODES) {
      const radio = radios.get(option.id);
      const item = items.get(option.id);
      const swatch = swatches.get(option.id);
      const caption = captions.get(option.id);
      if (radio) radio.checked = mode === option.id;
      if (item) item.classList.toggle("is-active", mode === option.id);
      if (swatch) {
        swatch.style.background =
          option.id === "custom" ? color : backdropCssValue({ mode: option.id, color });
        // Светлое превью получает тёмную окантовку, чтобы не сливаться с панелью.
        const swatchIsLight = option.id === "custom" ? light : option.id === "white";
        swatch.classList.toggle("is-light", swatchIsLight);
      }
      if (caption) caption.textContent = option.id === "custom" ? hexText : option.caption;
    }

    editor.hidden = mode !== "custom";

    if (source !== "picker") pickerInput.value = color;

    if (source !== "hex") {
      hexInput.value = hexText;
      hexInput.classList.remove("is-invalid");
      hexError.hidden = true;
    }

    for (const channel of CHANNELS) {
      const input = sliderInputs.get(channel.key);
      const value = sliderValues.get(channel.key);
      const rounded = Math.round(hsv[channel.key] || 0);
      if (source !== `slider-${channel.key}` && input.value !== String(rounded)) {
        input.value = String(rounded);
      }
      if (value) value.textContent = `${rounded}${channel.unit}`;
      if (input) input.style.setProperty("--track", trackFor(channel.key, hsv));
    }

    for (const button of quick.children) {
      button.classList.toggle("is-active", normalizeHex(button.dataset.hex) === color);
    }
  }

  function mutate(change, source) {
    selfUpdate = true;
    try {
      change();
    } finally {
      selfUpdate = false;
    }
    render(source);
  }

  function applyHex(hex, source) {
    const normalized = normalizeHex(hex);
    if (!normalized) return false;
    hsv = syncHsv(normalized, hsv);
    mutate(() => setBackdropColor(normalized), source);
    return true;
  }

  // --- события ---
  on(choices, "change", (event) => {
    const target = event.target;
    if (!target || target.type !== "radio" || target.name !== groupName) return;
    mutate(() => setBackdropMode(target.value), "mode");
  });

  // Системная палитра: значение приходит на каждый ход пипетки.
  on(pickerInput, "input", () => {
    applyHex(pickerInput.value, "picker");
  });

  on(hexInput, "input", () => {
    const typed = hexInput.value.trim();
    if (!typed) {
      hexInput.classList.add("is-invalid");
      hexError.hidden = false;
      return;
    }
    const normalized = normalizeHex(typed);
    if (!normalized) {
      // Неполный ввод («#12f4») — подсвечиваем ошибку, фон не трогаем.
      hexInput.classList.add("is-invalid");
      hexError.hidden = false;
      return;
    }
    hexInput.classList.remove("is-invalid");
    hexError.hidden = true;
    applyHex(normalized, "hex");
  });

  on(hexInput, "blur", () => {
    // Возвращаем канонический текст текущего цвета (или гасим ошибку).
    render(null);
  });

  on(hexInput, "keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      hexInput.blur();
    }
    event.stopPropagation();
  });

  for (const channel of CHANNELS) {
    const input = sliderInputs.get(channel.key);
    if (!input) continue;
    on(input, "input", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      hsv = { ...hsv, [channel.key]: value };
      mutate(() => setBackdropColor(hsvToHex(hsv)), `slider-${channel.key}`);
    });
    // Клавиши ползунка не должны уходить глобальным обработчикам экрана оценки.
    on(input, "keydown", (event) => event.stopPropagation());
  }

  on(quick, "click", (event) => {
    const button = event.target instanceof Element ? event.target.closest(".bg-quick-swatch") : null;
    if (!button) return;
    applyHex(button.dataset.hex, "quick");
  });

  const unsubscribe = subscribeBackdrop((backdrop) => {
    if (selfUpdate) return;
    hsv = syncHsv(backdrop.color, hsv);
    render(null);
  });

  render(null);

  function dispose() {
    unsubscribe();
    for (const [target, type, handler, opts] of listeners) target.removeEventListener(type, handler, opts);
    listeners.length = 0;
    root.replaceChildren();
    root.classList.remove("backdrop-control", `is-${variant}`);
  }

  return { element: root, refresh: () => render(null), dispose };
}
