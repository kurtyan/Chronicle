import type { Locale } from './translations'

export function systemLocale(language: string = typeof navigator === 'undefined' ? 'en' : navigator.language): Locale {
  return language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function urlLocale(search: string = typeof window === 'undefined' ? '' : window.location.search): Locale | null {
  const language = new URLSearchParams(search).get('lang')
  return language === 'en' || language === 'zh-CN' ? language : null
}
