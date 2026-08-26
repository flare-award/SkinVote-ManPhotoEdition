// Единый источник правды для категорий оценки фото.
// Карточки рейтинга, сортировка таблицы лидеров, фильтры, шапка таблицы,
// разбивка в детальном просмотре, экспорт и импорт — всё строится отсюда,
// поэтому для добавления/переименования категории правится только этот файл
// (цвета задаются в css/app.css по ключу категории).

export const CATEGORIES = [
  { key: "hairstyle", label: "Причёска" },
  { key: "eyeColor", label: "Цвет глаз" },
  { key: "topClothes", label: "Верхняя одежда" },
  { key: "bottomClothes", label: "Нижняя одежда" },
  { key: "shoes", label: "Обувь" },
  { key: "accessories", label: "Аксессуары" },
];

export const CATEGORY_KEYS = CATEGORIES.map((cat) => cat.key);

// Пустой набор оценок: у нового фото каждая категория ещё не оценена.
export function emptyRatings(value = null) {
  return Object.fromEntries(CATEGORY_KEYS.map((key) => [key, value]));
}

// Человекочитаемое название категории по ключу.
export function categoryLabel(key) {
  const found = CATEGORIES.find((cat) => cat.key === key);
  return found ? found.label : key;
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
