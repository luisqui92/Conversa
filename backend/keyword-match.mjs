// Compare complete Unicode words. A phrase must match consecutive words.
const words = (value) =>
  String(value)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
export function matchesKeyword(text, keyword) {
  const input = words(text),
    target = words(keyword);
  return (
    target.length > 0 &&
    input.some((_, start) => target.every((word, offset) => input[start + offset] === word))
  );
}
