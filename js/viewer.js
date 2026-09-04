// Двумерный вьюер фото. Фото вписывается в сцену без растяжения (contain):
// используется только translate + scale, никакой деформации изображения.
//
// Управление:
//   • ЛКМ (один палец) — перемещение в 2D;
//   • колесо мыши / pinch на тач-устройстве — масштаб вокруг курсора;
//   • двойной клик — быстрый зум (и обратно к вписанному виду);
//   • кнопки +/−/вписать и клавиатура (+, −, 0, стрелки) — если сцена в фокусе.
//
// Масштаб задаётся относительно «вписанного» вида: 100% = фото вписано в
// рамку, ниже можно отдалить, выше — приблизить до MAX_ZOOM_RATIO.

const FIT_MARGIN = 0.96; // небольшой отступ от краёв рамки
const MIN_ZOOM_RATIO = 0.2; // насколько можно отдалиться от вписанного вида
const MAX_ZOOM_RATIO = 40; // насколько можно приблизиться (относительно вписанного)
const MAX_ABS_SCALE = 16; // абсолютный потолок масштаба (защита от микроскопичных фото)
const ZOOM_STEP = 1.25; // шаг зума кнопками/клавишами
const DBLCLICK_ZOOM_RATIO = 2.5; // цель двойного клика: 2.5× вписанного
const PAN_STEP = 56; // пикселей на нажатие стрелки
const DRAG_THRESHOLD = 6; // пикселей движения, после которых жест считается перетаскиванием

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Плейсхолдер для фото без файла (например, импортированных из JSON, когда сам
// файл недоступен). Минимальный data-URL, чтобы в таблице не было пустоты.
const PLACEHOLDER_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="196" viewBox="0 0 280 196">` +
      `<rect width="280" height="196" fill="#12131a"/>` +
      `<rect x="90" y="54" width="100" height="70" rx="8" fill="#262736"/>` +
      `<circle cx="120" cy="78" r="9" fill="#3a3c50"/>` +
      `<path d="M98 116l26-24 16 14 13-11 23 21z" fill="#3a3c50"/>` +
      `<text x="140" y="158" font-family="sans-serif" font-size="13" fill="#918ca0" text-anchor="middle">фото недоступно</text>` +
      `</svg>`,
  );

/**
 * Создаёт 2D-вьюер фото внутри контейнера-сцены.
 *
 * @param {HTMLElement} stage контейнер с position: relative и overflow: hidden;
 *   внутрь вставляются <img> и (опционально) чип процента.
 * @param {object} [options]
 * @param {boolean} [options.showChip=true] показывать ли чип с процентом в углу сцены.
 * @param {boolean} [options.focusable=true] давать ли сцене tabindex (клавиатурный зум).
 * @param {(ratio: number) => void} [options.onZoom] вызывается с новым масштабом
 *   относительно вписанного вида (1 = 100%).
 * @param {string} [options.alt] alt для изображения.
 */
export function createPhotoViewer(stage, options = {}) {
  const showChip = options.showChip !== false;
  const focusable = options.focusable !== false;
  const onZoom = typeof options.onZoom === "function" ? options.onZoom : null;

  stage.classList.add("photo-stage");
  if (focusable) {
    stage.setAttribute("tabindex", "0");
    stage.setAttribute("role", "img");
    stage.setAttribute("aria-label", "Просмотр фото: перемещение и масштаб");
  }

  const img = document.createElement("img");
  img.className = "photo-stage-img";
  img.alt = options.alt || "";
  img.draggable = false;

  const empty = document.createElement("div");
  empty.className = "photo-stage-empty";
  empty.textContent = "Фото недоступно — файл не подключён в этой сессии";
  empty.hidden = true;

  let chip = null;
  if (showChip) {
    chip = document.createElement("span");
    chip.className = "zoom-chip";
    chip.textContent = "100%";
  }

  // ВАЖНО: Element.append() приводит не-Node аргументы к строке. Если передать
  // сюда null (чип скрыт), в сцену добавится текстовый узел "null",
  // который виден слева сверху в окне просмотра фото.
  stage.append(img, empty);
  if (chip) stage.append(chip);

  // --- состояние ---
  let stageW = 0;
  let stageH = 0;
  let naturalW = 0;
  let naturalH = 0;
  let fitScale = 1; // масштаб вписанного вида (100%)
  let scale = 1; // текущий абсолютный масштаб
  let tx = 0; // смещение левого верхнего угла фото в px сцены
  let ty = 0;
  let loaded = false;
  let pendingFit = false; // фото загружено, но сцена ещё не получила размер
  let raf = 0;
  let disposed = false;
  let suppressClick = false; // последний pointerup был перетаскиванием → клики игнорировать

  const pointers = new Map(); // pointerId -> {x, y}
  let drag = null; // {id, lastX, lastY, moved}
  let pinch = null; // {dist, midX, midY, scale, tx, ty}

  const clampScale = (value) =>
    fitScale > 0
      ? clamp(value, fitScale * MIN_ZOOM_RATIO, Math.min(fitScale * MAX_ZOOM_RATIO, MAX_ABS_SCALE))
      : value;

  const fitScaleFor = () => {
    if (!naturalW || !naturalH || !stageW || !stageH) return 1;
    return FIT_MARGIN * Math.min(stageW / naturalW, stageH / naturalH);
  };

  // Перерисовка через rAF: события указателя приходят чаще, чем кадры.
  function apply() {
    if (disposed || raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      if (disposed) return;
      img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
      const ratio = fitScale > 0 ? scale / fitScale : 1;
      if (chip) chip.textContent = `${Math.round(ratio * 100)}%`;
      if (onZoom) onZoom(ratio);
    });
  }

  // Фото никогда не «вылетает» за кадр: при зуме вперёд края фото можно довести
  // до краёв сцены, при зуме назад фото центрируется по соответствующей оси.
  function clampView() {
    scale = clampScale(scale);
    const dw = naturalW * scale;
    const dh = naturalH * scale;
    tx = dw <= stageW ? (stageW - dw) / 2 : clamp(tx, stageW - dw, 0);
    ty = dh <= stageH ? (stageH - dh) / 2 : clamp(ty, stageH - dh, 0);
  }

  function resetView() {
    if (!loaded) return;
    scale = fitScale;
    clampView();
    apply();
  }

  function zoomAt(px, py, factor) {
    if (!loaded) return;
    const target = clampScale(scale * factor);
    if (target === scale) return;
    const f = target / scale;
    // Точка фото под (px, py) остаётся на месте.
    tx = px - (px - tx) * f;
    ty = py - (py - ty) * f;
    scale = target;
    clampView();
    apply();
  }

  const zoomStep = (factor) => zoomAt(stageW / 2, stageH / 2, factor);

  // --- загрузка фото ---
  function applyFitAfterLoad() {
    const rect = stage.getBoundingClientRect();
    stageW = Math.floor(rect.width);
    stageH = Math.floor(rect.height);
    fitScale = fitScaleFor();
    if (stageW < 8 || stageH < 8 || !fitScale) {
      // Сцена ещё не получила размеры (экран скрыт) — впишемся, когда они появятся.
      pendingFit = true;
      return false;
    }
    scale = fitScale;
    clampView();
    loaded = true;
    img.classList.add("is-ready");
    apply();
    return true;
  }

  function load(src, alt) {
    if (disposed) return Promise.resolve();
    pointers.clear();
    drag = null;
    pinch = null;
    loaded = false;
    pendingFit = false;
    naturalW = 0;
    naturalH = 0;
    img.classList.remove("is-ready");
    if (typeof alt === "string") img.alt = alt;
    empty.hidden = !!src;
    if (!src) {
      img.hidden = true;
      if (chip) chip.hidden = true;
      return Promise.resolve();
    }
    img.hidden = false;
    if (chip) chip.hidden = false;

    // Уже загруженный тот же URL — не ждём сеть, просто вписываем заново.
    if (img.src === src && img.complete && img.naturalWidth) {
      naturalW = img.naturalWidth;
      naturalH = img.naturalHeight;
      const fitted = applyFitAfterLoad();
      if (!fitted && !pendingFit) pendingFit = true;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        img.onload = null;
        img.onerror = null;
        if (!ok) {
          empty.hidden = false;
          img.hidden = true;
          if (chip) chip.hidden = true;
          resolve();
          return;
        }
        naturalW = img.naturalWidth;
        naturalH = img.naturalHeight;
        if (!applyFitAfterLoad()) pendingFit = true;
        resolve();
      };
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = src;
      // decode() даёт ошибку раньше, чем onerror, и проверяет декомпозицию;
      // в старых Safari его нет — event-based fallback выше перекроет случай.
      if (typeof img.decode === "function") {
        img.decode().then(() => finish(true), () => finish(false));
      }
    });
  }

  // --- размеры сцены ---
  const ro = new ResizeObserver(() => {
    if (disposed) return;
    const rect = stage.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w < 8 || h < 8) return;

    const prevW = stageW;
    const prevH = stageH;
    const prevFit = fitScale;
    stageW = w;
    stageH = h;
    fitScale = fitScaleFor();

    if (!loaded) {
      if (pendingFit && naturalW && naturalH) {
        pendingFit = false;
        scale = fitScale;
        clampView();
        loaded = true;
        img.classList.add("is-ready");
        apply();
      }
      return;
    }

    if (prevW >= 8 && prevH >= 8 && prevFit > 0) {
      // Сохраняем относительный зум и точку фото под центром сцены: после
      // ресайза она остаётся под новым центром.
      const ratio = scale / prevFit;
      const wx = (prevW / 2 - tx) / scale;
      const wy = (prevH / 2 - ty) / scale;
      scale = clampScale(fitScale * ratio);
      tx = stageW / 2 - wx * scale;
      ty = stageH / 2 - wy * scale;
    }
    clampView();
    apply();
  });
  ro.observe(stage);

  // --- события ---
  function onWheel(event) {
    if (!loaded) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 32; // «строки»
    else if (event.deltaMode === 2) delta *= stageH; // «страницы»
    // ctrlKey — pinch-жест трекпада (браузер шлёт wheel с ctrlKey).
    const factor = Math.exp(-delta * (event.ctrlKey ? 0.008 : 0.0016));
    zoomAt(px, py, factor);
  }

  function onPointerDown(event) {
    if (!loaded) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (typeof stage.setPointerCapture === "function") {
      try {
        stage.setPointerCapture(event.pointerId);
      } catch {
        // не критично: без capture жест просто оборвётся за пределами сцены
      }
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      suppressClick = false;
      drag = { id: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: 0 };
      stage.classList.add("is-dragging");
    } else if (pointers.size === 2) {
      drag = null;
      // Pinch — тоже не клик: не даём «выбрать» карточку после щипка.
      suppressClick = true;
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        scale,
        tx,
        ty,
      };
    }
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const rect = stage.getBoundingClientRect();
      const midX = (a.x + b.x) / 2 - rect.left;
      const midY = (a.y + b.y) / 2 - rect.top;
      // Точка фото под исходной серединой щипка следует за новой серединой.
      const wx = (pinch.midX - rect.left - pinch.tx) / pinch.scale;
      const wy = (pinch.midY - rect.top - pinch.ty) / pinch.scale;
      scale = clampScale(pinch.scale * (dist / pinch.dist));
      tx = midX - wx * scale;
      ty = midY - wy * scale;
      clampView();
      apply();
      return;
    }

    if (drag && event.pointerId === drag.id) {
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved >= DRAG_THRESHOLD) suppressClick = true;
      tx += dx;
      ty += dy;
      clampView();
      apply();
    }
  }

  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);

    if (pinch && pointers.size < 2) {
      pinch = null;
      const [restId, rest] = [...pointers.entries()][0] || [];
      // Остался один палец — продолжаем с него перетаскивание.
      if (rest) drag = { id: restId, lastX: rest.x, lastY: rest.y, moved: DRAG_THRESHOLD };
    }
    if (drag && event.pointerId === drag.id) drag = null;
    if (!pointers.size) stage.classList.remove("is-dragging");
  }

  function onDblClick(event) {
    if (!loaded) return;
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const ratio = fitScale > 0 ? scale / fitScale : 1;
    if (ratio > 1.6) resetView();
    else zoomAt(px, py, DBLCLICK_ZOOM_RATIO / Math.max(ratio, 0.001));
  }

  function onKeyDown(event) {
    if (!loaded) return;
    let handled = true;
    switch (event.key) {
      case "+":
      case "=":
        zoomStep(ZOOM_STEP);
        break;
      case "-":
      case "_":
        zoomStep(1 / ZOOM_STEP);
        break;
      case "0":
        resetView();
        break;
      case "ArrowLeft":
        tx += PAN_STEP;
        clampView();
        apply();
        break;
      case "ArrowRight":
        tx -= PAN_STEP;
        clampView();
        apply();
        break;
      case "ArrowUp":
        ty += PAN_STEP;
        clampView();
        apply();
        break;
      case "ArrowDown":
        ty -= PAN_STEP;
        clampView();
        apply();
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  }

  const listeners = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  };
  on(stage, "wheel", onWheel, { passive: false });
  on(stage, "pointerdown", onPointerDown);
  on(stage, "pointermove", onPointerMove);
  on(stage, "pointerup", endPointer);
  on(stage, "pointercancel", endPointer);
  on(stage, "dblclick", onDblClick);
  on(stage, "keydown", onKeyDown);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (raf) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    ro.disconnect();
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    img.remove();
    empty.remove();
    if (chip) chip.remove();
    stage.classList.remove("photo-stage", "is-dragging");
    if (focusable) {
      stage.removeAttribute("tabindex");
      stage.removeAttribute("role");
      stage.removeAttribute("aria-label");
    }
  }

  return {
    load,
    resetView,
    zoomIn: () => zoomStep(ZOOM_STEP),
    zoomOut: () => zoomStep(1 / ZOOM_STEP),
    // Потребляет клик, если он вырос из перетаскивания (для кнопок-карточек).
    suppressClick: () => {
      const value = suppressClick;
      suppressClick = false;
      return value;
    },
    dispose,
  };
}

// --- Миниатюры фото (таблица лидеров и подиум) ---
// Один offscreen-canvas: изображение кропится по-«обложке» (как
// object-fit: cover), результат ужимается в data-URL. 280×196 совпадает
// с пропорциями контейнера .thumb-wrap, поэтому кроп в CSS повторяется точно.
const THUMB_WIDTH = 280;
const THUMB_HEIGHT = 196;

let thumbEngine = null;

function getThumbEngine() {
  if (thumbEngine) return thumbEngine;
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext("2d");
  let chain = Promise.resolve();
  thumbEngine = {
    capture(src) {
      chain = chain
        .then(
          () =>
            new Promise((resolve) => {
              if (!ctx) {
                resolve(null);
                return;
              }
              const image = new Image();
              image.onload = () => {
                const iw = image.naturalWidth;
                const ih = image.naturalHeight;
                if (!iw || !ih) {
                  resolve(null);
                  return;
                }
                const s = Math.max(THUMB_WIDTH / iw, THUMB_HEIGHT / ih);
                const dw = iw * s;
                const dh = ih * s;
                ctx.fillStyle = "#12131a";
                ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(image, (THUMB_WIDTH - dw) / 2, (THUMB_HEIGHT - dh) / 2, dw, dh);
                resolve(canvas.toDataURL("image/jpeg", 0.85));
              };
              image.onerror = () => resolve(null);
              image.src = src;
            }),
        )
        .catch(() => null);
      return chain;
    },
    dispose() {
      thumbEngine = null;
    },
  };
  return thumbEngine;
}

export async function captureThumb(photo) {
  // Нет реального файла (импорт без фото) — отдаём плейсхолдер, canvas не трогаем.
  if (!photo.url) {
    photo.thumb = PLACEHOLDER_THUMB;
    return photo.thumb;
  }
  const data = await getThumbEngine().capture(photo.url);
  photo.thumb = data || PLACEHOLDER_THUMB;
  return photo.thumb;
}

export function disposeThumbEngine() {
  if (thumbEngine) thumbEngine.dispose();
}

export function thumbPlaceholder() {
  return PLACEHOLDER_THUMB;
}
