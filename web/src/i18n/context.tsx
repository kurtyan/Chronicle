import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { zhCN, enUS, type Locale as DateFnsLocale } from 'date-fns/locale'
import type { Locale } from './translations'
import { translations } from './translations'

const dateLocaleMap: Record<Locale, DateFnsLocale> = {
  'zh-CN': zhCN,
  'en': enUS,
}

function resolveLocale(): Locale {
  // 1. URL ?lang= param (highest priority)
  const params = new URLSearchParams(window.location.search)
  const urlLang = params.get('lang')
  if (urlLang === 'en' || urlLang === 'zh-CN') return urlLang

  // 2. navigator.language
  const nav = navigator.language
  if (nav.startsWith('zh')) return 'zh-CN'
  return 'en'
}

function setLocaleInUrl(locale: Locale) {
  const params = new URLSearchParams(window.location.search)
  params.set('lang', locale)
  const newUrl = `${window.location.pathname}?${params.toString()}`
  window.history.replaceState({}, '', newUrl)
}

interface I18nContextValue {
  t: (key: string, params?: Record<string, string>) => string
  locale: Locale
  setLocale: (locale: Locale) => void
  dateLocale: DateFnsLocale
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(resolveLocale)

  useEffect(() => {
    setLocaleInUrl(locale)
  }, [locale])

  const t = useCallback((key: string, params?: Record<string, string>): string => {
    let text = translations[key]?.[locale] ?? key
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        text = text.replace(`{${k}}`, v)
      })
    }
    return text
  }, [locale])

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale)
  }, [])

  const value: I18nContextValue = {
    t,
    locale,
    setLocale,
    dateLocale: dateLocaleMap[locale],
  }

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
