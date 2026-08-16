// Central language registry. Add a row here and it shows up in BOTH the
// source and target pickers and in the server prompt — no other edits needed.
export type Lang = { code: string; label: string; name: string };

export const LANGS: Lang[] = [
  { code: "ja", label: "Japanese", name: "Japanese" },
  { code: "zh", label: "Chinese (Simplified/Traditional)", name: "Chinese" },
  { code: "ko", label: "Korean", name: "Korean" },
  { code: "en", label: "English", name: "English" },
  { code: "es", label: "Spanish", name: "Spanish" },
  { code: "fr", label: "French", name: "French" },
  { code: "de", label: "German", name: "German" },
  { code: "pt", label: "Portuguese", name: "Portuguese" },
  { code: "it", label: "Italian", name: "Italian" },
  { code: "ru", label: "Russian", name: "Russian" },
  { code: "ar", label: "Arabic", name: "Arabic" },
  { code: "hi", label: "Hindi", name: "Hindi" },
  { code: "id", label: "Indonesian", name: "Indonesian" },
  { code: "th", label: "Thai", name: "Thai" },
  { code: "vi", label: "Vietnamese", name: "Vietnamese" },
  { code: "tr", label: "Turkish", name: "Turkish" },
  { code: "pl", label: "Polish", name: "Polish" },
  { code: "nl", label: "Dutch", name: "Dutch" },
  { code: "sv", label: "Swedish", name: "Swedish" },
  { code: "tl", label: "Tagalog", name: "Tagalog" },
];

export const LANG_NAMES: Record<string, string> = {
  auto: "the source language (auto-detect)",
  ...Object.fromEntries(LANGS.map((l) => [l.code, l.name])),
};

export function langName(code: string, fallback = "English") {
  return LANG_NAMES[code] || fallback;
}

// Languages whose script has no spaces / needs vertical handling hints.
export const CJK = new Set(["ja", "zh", "ko"]);
