export interface CompanionSettings {
  includeReasoning: boolean
  includeRichAppendix: boolean
  batchLimit: 5 | 10 | 20 | 28
  screenshotScale: 1 | 1.5 | 2
  fleetEnabled: boolean
  fleetPollIntervalMs: 30_000 | 60_000 | 120_000 | 300_000 | 600_000
  fleetStreamRecheckMs: 0 | 60_000 | 120_000 | 300_000 | 600_000
  fleetMaxStatusChecksPerPoll: 1 | 2 | 4 | 8
  historyAuditDelayMs: 1_000 | 2_000 | 5_000 | 10_000
  historyAuditDefaultLimit: 25 | 50 | 100 | 200
  rateLimitBackoffMs: 900_000 | 1_800_000 | 3_600_000 | 7_200_000
}

const STORAGE_KEY = 'chatgpt-companion/settings/v1'

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  includeReasoning: false,
  includeRichAppendix: false,
  batchLimit: 10,
  screenshotScale: 1.5,
  fleetEnabled: true,
  fleetPollIntervalMs: 120_000,
  fleetStreamRecheckMs: 0,
  fleetMaxStatusChecksPerPoll: 2,
  historyAuditDelayMs: 5_000,
  historyAuditDefaultLimit: 50,
  rateLimitBackoffMs: 3_600_000,
}

function validBatchLimit(value: unknown): value is CompanionSettings['batchLimit'] {
  return value === 5 || value === 10 || value === 20 || value === 28
}

function validScreenshotScale(value: unknown): value is CompanionSettings['screenshotScale'] {
  return value === 1 || value === 1.5 || value === 2
}

function validFleetPollInterval(value: unknown): value is CompanionSettings['fleetPollIntervalMs'] {
  return value === 30_000 || value === 60_000 || value === 120_000 || value === 300_000 || value === 600_000
}

function validStreamRecheck(value: unknown): value is CompanionSettings['fleetStreamRecheckMs'] {
  return value === 0 || value === 60_000 || value === 120_000 || value === 300_000 || value === 600_000
}

function validMaxStatusChecks(value: unknown): value is CompanionSettings['fleetMaxStatusChecksPerPoll'] {
  return value === 1 || value === 2 || value === 4 || value === 8
}

function validHistoryAuditDelay(value: unknown): value is CompanionSettings['historyAuditDelayMs'] {
  return value === 1_000 || value === 2_000 || value === 5_000 || value === 10_000
}

function validHistoryAuditLimit(value: unknown): value is CompanionSettings['historyAuditDefaultLimit'] {
  return value === 25 || value === 50 || value === 100 || value === 200
}

function validRateLimitBackoff(value: unknown): value is CompanionSettings['rateLimitBackoffMs'] {
  return value === 900_000 || value === 1_800_000 || value === 3_600_000 || value === 7_200_000
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
      fleetEnabled: parsed.fleetEnabled !== false,
      fleetPollIntervalMs: validFleetPollInterval(parsed.fleetPollIntervalMs) ? parsed.fleetPollIntervalMs : DEFAULT_COMPANION_SETTINGS.fleetPollIntervalMs,
      fleetStreamRecheckMs: validStreamRecheck(parsed.fleetStreamRecheckMs) ? parsed.fleetStreamRecheckMs : DEFAULT_COMPANION_SETTINGS.fleetStreamRecheckMs,
      fleetMaxStatusChecksPerPoll: validMaxStatusChecks(parsed.fleetMaxStatusChecksPerPoll) ? parsed.fleetMaxStatusChecksPerPoll : DEFAULT_COMPANION_SETTINGS.fleetMaxStatusChecksPerPoll,
      historyAuditDelayMs: validHistoryAuditDelay(parsed.historyAuditDelayMs) ? parsed.historyAuditDelayMs : DEFAULT_COMPANION_SETTINGS.historyAuditDelayMs,
      historyAuditDefaultLimit: validHistoryAuditLimit(parsed.historyAuditDefaultLimit) ? parsed.historyAuditDefaultLimit : DEFAULT_COMPANION_SETTINGS.historyAuditDefaultLimit,
      rateLimitBackoffMs: validRateLimitBackoff(parsed.rateLimitBackoffMs) ? parsed.rateLimitBackoffMs : DEFAULT_COMPANION_SETTINGS.rateLimitBackoffMs,
    }
  }
  catch {
    return { ...DEFAULT_COMPANION_SETTINGS }
  }
}

export function saveCompanionSettings(settings: CompanionSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}
