/**
 * 配置解析 —— 零依赖，不 import @deepseek-ai/schemastery。
 *
 * 为什么不用 schemastery：本插件在 profile 里是「本地目录 → junction」挂载的，
 * Node 会按 *真实路径*（D:\codex\...）去找 node_modules，永远走不到 profile 里
 * 那份 @deepseek-ai/schemastery，插件会直接 import 失败。所以这里自带默认值
 * 和校验，坏配置当场抛错（fail loud），不静默回退。
 */

/** 出厂值。patch 里的 config 会覆盖它。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  minSeconds: 20,
  milestones: Object.freeze([10, 25, 50, 75, 90]),
  reportInChat: true,
  language: 'zh',
  order: 9200,
  helperDir: '',
  debug: false,
})

export const LANGUAGES = Object.freeze(['zh', 'en'])

/** 合法排序区间：narration 主段 8950、尾部提醒 10150，插在两者之间。 */
const MIN_ORDER = 100
const MAX_ORDER = 20000

function fail(message) {
  throw new Error(`dsh-script-progress: ${message}`)
}

function asBoolean(value, key, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
  }
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
  fail(`${key} 必须是布尔值，收到 ${JSON.stringify(value)}`)
}

function asNumber(value, key, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) fail(`${key} 必须是数字，收到 ${JSON.stringify(value)}`)
  return parsed
}

function asString(value, key, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') fail(`${key} 必须是字符串，收到 ${JSON.stringify(value)}`)
  return value
}

/** 里程碑：1–99 的整数，去重后升序。100 由 close() 单独负责。 */
function asMilestones(value, fallback) {
  if (value === undefined || value === null) return [...fallback]
  if (typeof value === 'string') {
    value = value.split(',').map((part) => part.trim()).filter((part) => part !== '')
  }
  if (!Array.isArray(value)) fail(`milestones 必须是数组，收到 ${JSON.stringify(value)}`)
  const out = []
  for (const item of value) {
    const number = Number(item)
    if (!Number.isInteger(number)) fail(`milestones 的每一项都必须是整数，收到 ${JSON.stringify(item)}`)
    if (number < 1 || number > 99) fail(`milestones 每一项都要在 1–99 之间（100 自动添加），收到 ${number}`)
    out.push(number)
  }
  if (out.length === 0) fail('milestones 不能是空数组（想关掉里程碑请用 enabled: false）')
  return [...new Set(out)].sort((a, b) => a - b)
}

/**
 * 把 patch 里的原始 config 解析成完整、校验过的设置。
 * 每次装配系统提示都会调一次，所以必须便宜且无副作用。
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}

  const order = asNumber(source.order, 'order', DEFAULTS.order)
  if (!Number.isFinite(order) || order < MIN_ORDER || order > MAX_ORDER) {
    fail(`order 必须在 ${MIN_ORDER}–${MAX_ORDER} 之间，收到 ${order}`)
  }

  const minSeconds = asNumber(source.minSeconds, 'minSeconds', DEFAULTS.minSeconds)
  if (minSeconds < 0) fail(`minSeconds 不能为负数，收到 ${minSeconds}`)

  const language = asString(source.language, 'language', DEFAULTS.language).trim().toLowerCase()
  if (!LANGUAGES.includes(language)) {
    fail(`language 只能是 ${LANGUAGES.join(' / ')}，收到 ${JSON.stringify(language)}`)
  }

  return {
    enabled: asBoolean(source.enabled, 'enabled', DEFAULTS.enabled),
    minSeconds,
    milestones: asMilestones(source.milestones, DEFAULTS.milestones),
    reportInChat: asBoolean(source.reportInChat, 'reportInChat', DEFAULTS.reportInChat),
    language,
    order,
    helperDir: asString(source.helperDir, 'helperDir', DEFAULTS.helperDir).trim(),
    debug: asBoolean(source.debug, 'debug', DEFAULTS.debug),
  }
}
