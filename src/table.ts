export function getDisplayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0x33bf) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function truncateToWidth(str: string, maxWidth: number): string {
  let width = 0;
  let i = 0;
  const chars = [...str];
  while (i < chars.length) {
    const charWidth = getDisplayWidth(chars[i]);
    if (width + charWidth > maxWidth - 3) {
      return chars.slice(0, i).join("") + "...";
    }
    width += charWidth;
    i++;
  }
  return str;
}

export function padToWidth(str: string, targetWidth: number): string {
  const currentWidth = getDisplayWidth(str);
  const padding = targetWidth - currentWidth;
  return padding > 0 ? str + " ".repeat(padding) : str;
}
