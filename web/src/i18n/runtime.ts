import { translations, type Locale } from './translations'
import { systemLocale, urlLocale } from './locale'

// Non-React services share the provider's locale without depending on a hook.
let currentLocale: Locale = urlLocale() || systemLocale()

export function setRuntimeLocale(locale: Locale) {
  currentLocale = locale
}

export function translateCurrent(key: string, params?: Record<string, string>): string {
  let result = translations[key]?.[currentLocale] ?? key
  for (const [name, value] of Object.entries(params || {})) result = result.replace(`{${name}}`, value)
  return result
}
