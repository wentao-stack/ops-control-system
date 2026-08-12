import i18n from "i18next"
import { initReactI18next } from "react-i18next"

import zhTW from "./locales/zh-TW.json"
import ja from "./locales/ja.json"
import en from "./locales/en.json"

const savedLang = (() => {
  try { return localStorage.getItem("ocs-lang") } catch { return null }
})()

i18n.use(initReactI18next).init({
  resources: {
    "zh-TW": { translation: zhTW },
    "ja": { translation: ja },
    "en": { translation: en },
  },
  lng: savedLang || "zh-TW",
  fallbackLng: "zh-TW",
  interpolation: { escapeValue: false },
})

i18n.on("languageChanged", (lng) => {
  try { localStorage.setItem("ocs-lang", lng) } catch {}
})

export default i18n
