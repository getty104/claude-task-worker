import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "brave", "calm", "dark", "eager", "fair",
  "gentle", "happy", "keen", "lively", "noble",
  "proud", "quiet", "rapid", "sharp", "swift",
  "tender", "vivid", "warm", "bold", "bright",
  "clever", "daring", "fierce", "grand", "humble",
  "jovial", "kind", "lucky", "mighty", "neat",
];

const NOUNS = [
  "falcon", "river", "cedar", "flame", "stone",
  "breeze", "coral", "delta", "frost", "grove",
  "harbor", "iris", "jade", "lark", "maple",
  "orbit", "pearl", "ridge", "spark", "tide",
  "vale", "wolf", "apex", "bloom", "crest",
  "dawn", "ember", "flint", "hawk", "sage",
];

function pick(list: string[]): string {
  return list[randomInt(list.length)];
}

export function generateWorktreeName(): string {
  const suffix = String(randomInt(10000)).padStart(4, "0");
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
}
