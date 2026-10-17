/**
 * Sentinel Override — Shared Constants
 * Centralized timeout and configuration values used across the extension.
 */

// API request timeouts (in milliseconds)
export const API_TIMEOUT_MS = 30000; // 30 seconds - standard timeout for LLM API calls
export const VISION_FETCH_TIMEOUT_MS = 120000; // 120s - vision payloads + slow-thinking models often need >30s to first byte
export const API_CACHE_TTL_MS = 30000; // 30 seconds - cache TTL for API responses

// Cache TTL values (in milliseconds)
export const PLATFORM_CTX_CACHE_TTL_MS = 30000; // 30 seconds - platform context cache
export const BATCH_MODE_CACHE_TTL_MS = 60000; // 60 seconds - extended cache in batch mode

// Scheduler refresh interval (in milliseconds)
export const SCHEDULER_REFRESH_INTERVAL_MS = 30000; // 30 seconds - refresh countdown timers

// Maximum wait time for commands (in milliseconds)
export const MAX_WAIT_TIME_MS = 30000; // 30 seconds - maximum wait command duration

// Time interval constants (in milliseconds)
export const ONE_HUNDRED_MS = 100; // 100 milliseconds
export const ONE_HUNDRED_FIFTY_MS = 150; // 150 milliseconds
export const TWO_HUNDRED_MS = 200; // 200 milliseconds
export const THREE_HUNDRED_MS = 300; // 300 milliseconds
export const FOUR_HUNDRED_MS = 400; // 400 milliseconds
export const FIVE_HUNDRED_MS = 500; // 500 milliseconds
export const SIX_HUNDRED_MS = 600; // 600 milliseconds
export const EIGHT_HUNDRED_MS = 800; // 800 milliseconds
export const ONE_SECOND_MS = 1000; // 1 second
export const TWO_SECONDS_MS = 2000; // 2 seconds
export const THREE_SECONDS_MS = 3000; // 3 seconds
export const FIVE_SECONDS_MS = 5000; // 5 seconds
export const TEN_SECONDS_MS = 10000; // 10 seconds
export const TWELVE_SECONDS_MS = 12000; // 12 seconds
export const FIFTEEN_SECONDS_MS = 15000; // 15 seconds
export const TWENTY_SECONDS_MS = 20000; // 20 seconds
export const THIRTY_SECONDS_MS = 30000; // 30 seconds
export const FORTY_FIVE_SECONDS_MS = 45000; // 45 seconds
export const ONE_MINUTE_MS = 60000; // 1 minute
export const FIVE_MINUTES_MS = 300000; // 5 minutes
export const ONE_HOUR_MS = 3600000; // 1 hour
export const ONE_DAY_MS = 86400000; // 24 hours

// Page content limits
export const MAX_PAGE_TEXT_LENGTH = 30000; // Maximum characters to extract from page text
export const TEXT_SAMPLE_LENGTH = 5000; // Maximum characters for text samples

// Report and log limits
export const MAX_REPORT_FINDING_LENGTH = 2000; // Maximum characters for report findings before truncation
export const MAX_CDP_RESULT_LENGTH = 3000; // Maximum characters for CDP result strings
export const MAX_LOG_ENTRY_LENGTH = 1000; // Maximum characters for console log entries
