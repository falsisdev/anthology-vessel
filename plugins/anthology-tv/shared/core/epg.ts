const CHANNEL_LANG_LABELS: Record<string, string> = {
  tr: "Türkçe",
  en: "İngilizce",
  az: "Azerbaycan Türkçesi",
  ar: "Arapça",
  ku: "Kürtçe",
  de: "Almanca",
  fr: "Fransızca",
  ru: "Rusça",
  es: "İspanyolca",
  it: "İtalyanca",
};

export function channelLangLabel(code?: string): string {
  const key = (code ?? "").trim().toLowerCase() || "tr";
  return CHANNEL_LANG_LABELS[key] ?? "Türkçe";
}

export function formatChannelSynopsis(
  channelName: string,
  sectionTitle: string,
  langCode?: string,
): string {
  const cleanName = channelName.trim();
  const cleanCat = sectionTitle.trim();
  const lang = channelLangLabel(langCode);
  return cleanCat ? `${cleanName} • ${cleanCat} • Dil: ${lang}` : `${cleanName} • Dil: ${lang}`;
}
