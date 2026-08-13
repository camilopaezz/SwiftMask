import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";

/** Map OS locale → app language. Neutral Spanish for any `es*`. */
export function resolveAppLanguage(
  locale: string | undefined | null = typeof navigator !== "undefined"
    ? navigator.language
    : "en",
): "en" | "es" {
  const tag = (locale ?? "en").toLowerCase();
  return tag === "es" || tag.startsWith("es-") ? "es" : "en";
}

export function applyDocumentLang(lng: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lng === "es" ? "es" : "en";
}

const lng = resolveAppLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  lng,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  // Missing keys fall back to English; no console spam in prod.
  saveMissing: false,
  returnNull: false,
});

applyDocumentLang(i18n.language);
i18n.on("languageChanged", applyDocumentLang);

export default i18n;
