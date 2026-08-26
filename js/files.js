import { emptyRatings } from "./categories.js";

// Поддерживаемые фотоформаты: расширение либо MIME-тип файла.
export const ACCEPTED_IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
  ".tif",
  ".tiff",
];

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
  "image/tiff",
]);

// Лимит по мегапикселям: битмап крупнее разворачивает в браузере сотни мегабайт
// памяти, и вкладка может рухнуть. 64 Мп покрывает практически все камеры.
export const MAX_PIXELS = 64_000_000;

export function supportsFsAccess() {
  return typeof window.showOpenFilePicker === "function";
}

export function supportsDirPicker() {
  return typeof window.showDirectoryPicker === "function";
}

export function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function isImageFile(file) {
  if (!file) return false;
  const name = (file.name || "").toLowerCase();
  if (ACCEPTED_IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  return typeof file.type === "string" && ACCEPTED_IMAGE_TYPES.has(file.type);
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `photo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Декодируем файл и запоминаем его blob-URL как превью: дальше и вьюер, и
// генератор миниатюр работают с одним и тем же URL — браузер декодирует
// битмап один раз.
async function measureImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight, previewUrl: url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * Проверяет файл как фото: поддерживаемый формат, изображение декодируется,
 * у него реальные размеры и он не превышает лимит по мегапикселям.
 */
export async function inspectPhotoFile(entry) {
  const file = entry.file;
  const name = file.name || "unnamed.jpg";
  const relativePath = entry.relativePath || file.webkitRelativePath || name;

  if (!isImageFile(file)) {
    return {
      ok: false,
      name,
      relativePath,
      reason: "Не изображение (поддерживаются PNG, JPG, WebP, GIF, BMP, AVIF, TIFF)",
    };
  }

  let measured = null;
  try {
    measured = await measureImage(file);
    const { width, height, previewUrl } = measured;
    if (!width || !height) {
      URL.revokeObjectURL(previewUrl);
      return { ok: false, name, relativePath, reason: "Пустое изображение" };
    }
    if (width * height > MAX_PIXELS) {
      URL.revokeObjectURL(previewUrl);
      return {
        ok: false,
        name,
        relativePath,
        reason: `Слишком большое разрешение: ${(width * height) / 1e6 | 0} Мп при лимите ${MAX_PIXELS / 1e6 | 0} Мп`,
      };
    }

    return {
      ok: true,
      photo: {
        id: makeId(),
        name,
        relativePath,
        file,
        url: previewUrl,
        width,
        height,
        fileHandle: entry.fileHandle || null,
        dirHandle: entry.dirHandle || null,
        ratings: emptyRatings(),
        thumb: null,
        note: "",
        skipped: false,
        imported: false,
      },
    };
  } catch {
    if (measured?.previewUrl) URL.revokeObjectURL(measured.previewUrl);
    return {
      ok: false,
      name,
      relativePath,
      reason: "Повреждённое изображение",
    };
  }
}

async function walkDirectoryHandle(dirHandle, out, prefix = "", rootDir = dirHandle) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file") {
      const file = await handle.getFile();
      out.push({
        file,
        fileHandle: handle,
        dirHandle: rootDir,
        relativePath: prefix + name,
      });
    } else if (handle.kind === "directory") {
      await walkDirectoryHandle(handle, out, `${prefix}${name}/`, rootDir);
    }
  }
}

function readEntries(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

function entryToFile(fileEntry) {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });
}

async function walkDirEntry(dirEntry, out, prefix = "") {
  const reader = dirEntry.createReader();
  let batch = await readEntries(reader);
  while (batch.length) {
    for (const child of batch) {
      if (child.isFile) {
        const file = await entryToFile(child);
        out.push({
          file,
          relativePath: prefix + child.name,
        });
      } else if (child.isDirectory) {
        await walkDirEntry(child, out, `${prefix}${child.name}/`);
      }
    }
    batch = await readEntries(reader);
  }
}

export async function collectFromDataTransfer(dataTransfer) {
  const collected = [];
  const items = dataTransfer.items ? [...dataTransfer.items] : [];

  if (items.length && (items[0].getAsFileSystemHandle || items[0].webkitGetAsEntry)) {
    await Promise.all(
      items.map(async (item) => {
        if (item.kind !== "file") return;

        if (typeof item.getAsFileSystemHandle === "function") {
          try {
            const handle = await item.getAsFileSystemHandle();
            if (!handle) return;
            if (handle.kind === "file") {
              const file = await handle.getFile();
              collected.push({ file, fileHandle: handle, relativePath: file.name });
              return;
            }
            if (handle.kind === "directory") {
              await walkDirectoryHandle(handle, collected);
              return;
            }
          } catch {
            // fall through to webkit entry
          }
        }

        if (typeof item.webkitGetAsEntry === "function") {
          const entry = item.webkitGetAsEntry();
          if (!entry) return;
          if (entry.isFile) {
            const file = await entryToFile(entry);
            collected.push({ file, relativePath: file.name });
          } else if (entry.isDirectory) {
            await walkDirEntry(entry, collected, `${entry.name}/`);
          }
          return;
        }

        const file = item.getAsFile();
        if (file) collected.push({ file, relativePath: file.name });
      }),
    );
    return collected;
  }

  return [...dataTransfer.files].map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

export async function pickFilesWithFs() {
  const handles = await window.showOpenFilePicker({
    multiple: true,
    types: [
      {
        description: "Фото",
        accept: {
          "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff"],
        },
      },
    ],
    excludeAcceptAllOption: false,
  });

  const collected = [];
  for (const handle of handles) {
    const file = await handle.getFile();
    collected.push({ file, fileHandle: handle, relativePath: file.name });
  }
  return collected;
}

export async function pickFolderWithFs() {
  const dirHandle = await window.showDirectoryPicker({ mode: "read" });
  const collected = [];
  await walkDirectoryHandle(dirHandle, collected);
  return collected;
}

export function filesFromInput(fileList) {
  return [...fileList].map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

// Из браузера нельзя программно открыть системный проводник и выделить там файл —
// это ограничение веб-платформы. showDirectoryPicker — это диалог ВЫБОРА папки, а не
// «открыть в проводнике», поэтому он здесь больше не используется. Вместо этого
// возвращаем известный путь к файлу/папке, чтобы пользователь мог его скопировать.
export function revealPhoto(photo) {
  const relativePath = photo?.relativePath || photo?.name || "";
  const sep = relativePath.lastIndexOf("/");
  const dirPath = sep >= 0 ? relativePath.slice(0, sep) : "";
  return {
    mode: "path",
    path: relativePath || photo?.name || "",
    // Папка: если есть вложенность — берём её, иначе показываем хотя бы имя файла.
    dirPath: dirPath || relativePath || "",
    name: photo?.name || "",
  };
}

export function revokePhoto(photo) {
  if (photo?.url) URL.revokeObjectURL(photo.url);
}
