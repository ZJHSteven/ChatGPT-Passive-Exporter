export interface CompanionSettings {
  includeReasoning: boolean
  includeRichAppendix: boolean
  batchLimit: 5 | 10 | 20 | 28
  screenshotScale: 1 | 1.5 | 2
}

const STORAGE_KEY = 'chatgpt-companion/settings/v1'

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  includeReasoning: false,
  includeRichAppendix: false,
  batchLimit: 10,
  screenshotScale: 1.5,
}

function validBatchLimit(value: unknown): value is CompanionSettings['batchLimit'] {
  return value === 5 || value === 10 || value === 20 || value === 28
}

function validScreenshotScale(value: unknown): value is CompanionSettings['screenshotScale'] {
  return value === 1 || value === 1.5 || value === 2
}

export function loadCompanionSettings(): CompanionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_COMPANION_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<CompanionSettings>
    return {
      includeReasoning: parsed.includeReasoning === true,
      includeRichAppendix: parsed.includeRichAppendix === true,
      batchLimit: validBatchLimit(parsed.batchLimit) ? parsed.batchLimit : DEFAULT_COMPANION_SETTINGS.batchLimit,
      screenshotScale: validScreenshotScale(parsed.screenshotScale) ? parsed.screenshotScale : DEFAULT_COMPANION_SETTINGS.screenshotScale,
    }
  }
  catch {
    return { ...DEFAULT_COMPANION_SETTINGS }
  }
}

export function saveCompanionSettings(settings: CompanionSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}
