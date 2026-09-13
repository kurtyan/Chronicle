import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { zhCN, enUS, type Locale as DateFnsLocale } from 'date-fns/locale'
import type { Locale } from './translations'
import { translations } from './translations'
import { setRuntimeLocale } from './runtime'
import { systemLocale, urlLocale } from './locale'

const dateLocaleMap: Record<Locale, DateFnsLocale> = {
  'zh-CN': zhCN,
  'en': enUS,
}

function resolveLocale(): Locale {
  // 1. URL ?lang= param (highest priority)
  return urlLocale() || systemLocale()
}

async function resolveLocaleFromTauri(): Promise<Locale | null> {
  try {
    const tauri = (window as any).__TAURI__
    if (!tauri?.core) return null
    const lang: string = await tauri.core.invoke('get_ui_language')
    if (lang === 'zh-CN' || lang === 'zh') return 'zh-CN'
    if (lang === 'en') return 'en'
    // 'auto' follows the system, matching the initial browser locale.
    return systemLocale()
  } catch {
    return null
  }
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
  const explicitUrlLocale = useRef(urlLocale())
  const [locale, setLocaleState] = useState<Locale>(resolveLocale)

  // After mount, try loading language from Tauri config
  useEffect(() => {
    if (explicitUrlLocale.current) return
    resolveLocaleFromTauri().then(fromConfig => {
      if (fromConfig) {
        setRuntimeLocale(fromConfig)
        setLocaleState(fromConfig)
      }
    })
  }, [])

  useEffect(() => {
    setRuntimeLocale(locale)
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
    setRuntimeLocale(newLocale)
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
