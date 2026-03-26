import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "brave", "calm", "dark", "eager", "fair",
  "gentle", "happy", "keen", "lively", "noble",
  "proud", "quiet", "rapid", "sharp", "swift",
  "tender", "vivid", "warm", "bold", "bright",
  "clever", "daring", "fierce", "grand", "humble",
  "jovial", "kind", "lucky", "mighty", "neat",
  "agile", "amber", "breezy", "crisp", "deep",
  "dusty", "elfin", "frosty", "golden", "hardy",
  "icy", "joyful", "lean", "misty", "nimble",
  "open", "peppy", "radiant", "serene", "tidy",
  "upbeat", "valiant", "wiry", "zesty", "ancient",
  "brisk", "crispy", "deft", "earnest", "fleet",
  "airy", "ardent", "astute", "azure", "balmy",
  "blithe", "buoyant", "candid", "cheery", "coastal",
  "dashing", "dazzling", "devoted", "dynamic", "edgy",
  "elegant", "enduring", "exotic", "fabled", "faithful",
  "famous", "fearless", "flawless", "fluent", "focused",
  "forceful", "forged", "frank", "fresh", "frugal",
  "gallant", "gifted", "glowing", "graceful", "grounded",
  "honest", "hopeful", "ideal", "immense", "intact",
  "intrepid", "ironclad", "ivory", "keen", "knowing",
  "lavish", "level", "lithe", "lofty", "loyal",
  "luminous", "majestic", "mellow", "mindful", "modern",
];

const NOUNS = [
  "falcon", "river", "cedar", "flame", "stone",
  "breeze", "coral", "delta", "frost", "grove",
  "harbor", "iris", "jade", "lark", "maple",
  "orbit", "pearl", "ridge", "spark", "tide",
  "vale", "wolf", "apex", "bloom", "crest",
  "dawn", "ember", "flint", "hawk", "sage",
  "arrow", "basin", "cliff", "dune", "echo",
  "fern", "gale", "helm", "isle", "jungle",
  "kite", "lance", "marsh", "nova", "oak",
  "pine", "quill", "reef", "shore", "thorn",
  "umber", "veil", "wave", "xenon", "yew",
  "zenith", "acorn", "birch", "comet", "dew",
  "abyss", "anchor", "anvil", "arc", "ash",
  "atlas", "aurora", "axe", "bay", "beacon",
  "blade", "bolt", "brook", "bud", "burl",
  "cairn", "canopy", "cape", "cavern", "chain",
  "chalk", "chasm", "chord", "chrome", "citrus",
  "claw", "cloud", "cobalt", "creek", "crown",
  "crystal", "current", "cypress", "depot", "depth",
  "drift", "dusk", "dust", "eddy", "elm",
  "epoch", "ether", "field", "fin", "fjord",
  "foam", "forge", "fossil", "geyser", "glacier",
  "glow", "granite", "heath", "heron", "hollow",
];

function pick(list: string[]): string {
  return list[randomInt(list.length)];
}

export function generateWorktreeName(): string {
  const suffix = String(randomInt(10000)).padStart(4, "0");
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
}
