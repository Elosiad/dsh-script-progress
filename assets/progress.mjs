/**
 * dsh-script-progress · Node 版进度条。
 *
 * 用法：
 *   const { track, Progress } = await import(
 *     'file:///C:/Users/you/.dsh/script-progress/progress.mjs'
 *   )
 *
 *   for (const item of track(items, { label: '下载' })) { ... }
 *
 *   const p = new Progress({ total: urls.length, label: '下载', unit: 'req' })
 *   for (const url of urls) { p.update(null, url) }
 *   p.close()
 *
 * 输出只走 stderr，进度条只用 ASCII；写失败不会抛。
 */

export const MILESTONES = Object.freeze([10, 25, 50, 75, 90])
export const MARKER = '@@PROGRESS'

import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

function fmtSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function fmtRate(rate) {
  if (!Number.isFinite(rate)) return '0'
  if (rate >= 1000) return rate.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (rate >= 100) return rate.toFixed(0)
  if (rate >= 10) return rate.toFixed(1)
  return rate.toFixed(2)
}

function safeWrite(stream, text) {
  if (!text) return false
  try {
    stream.write(text)
    return true
  } catch {
    return false
  }
}

export class Progress {
  constructor({
    total = null,
    label = '',
    unit = 'it',
    stream = process.stderr,
    milestones = MILESTONES,
    width = 22,
    intervalMs = 500,
  } = {}) {
    this.total = Number.isFinite(Number(total)) && Number(total) > 0 ? Math.trunc(Number(total)) : null
    this.label = String(label ?? '')
    this.unit = String(unit ?? 'it')
    this.stream = stream
    this.milestones = [...new Set(milestones.map(Number))].sort((a, b) => a - b)
    this.width = Math.max(8, width)
    this.intervalMs = Math.max(0, intervalMs)

    this.done = 0
    this.startedAt = Date.now()
    this.lastPrintAt = 0
    this.milestoneIndex = 0
    this.closed = false
    this.tty = Boolean(stream?.isTTY)
    this.taskIdValue = null
    this.uiPathValue = null
    this.uiChecked = false
    this.uiLast = 0
  }

  /** DSH progress channel (dsh-task-progress protocol). */
  taskId() {
    if (this.taskIdValue === null) {
      const raw = this.label || ''
      let safe = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[._-]+|[._-]+$/g, '')
      if (safe.replace(/[^A-Za-z0-9]/g, '').length < 3) {
        safe = `task-${createHash('md5').update(raw).digest('hex').slice(0, 4)}`
      }
      this.taskIdValue = safe.slice(0, 40)
    }
    return this.taskIdValue
  }

  uiPath() {
    if (!this.uiChecked) {
      this.uiChecked = true
      const base = (process.env.DSH_PROGRESS_DIR ?? '').trim()
      if (base) this.uiPathValue = join(base, `${this.taskId()}.jsonl`)
    }
    return this.uiPathValue
  }

  publish(state, percent, message = '') {
    const path = this.uiPath()
    if (!path) return
    const now = Date.now()
    if (state === 'running' && now - this.uiLast < 1000) return
    this.uiLast = now
    const line = { v: 1, task: this.taskId(), state, at: now }
    if (percent !== null && Number.isFinite(percent)) {
      line.pct = Math.max(0, Math.min(100, Math.round(percent * 10) / 10))
    }
    if (this.total) {
      line.done = this.done
      line.total = this.total
    }
    line.unit = this.unit
    if (message) line.msg = String(message).slice(0, 200)
    else if (this.label) line.msg = this.label.slice(0, 200)
    try {
      appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8')
    } catch {
      // 界面进度永远不能拖垮脚本本身。
      this.uiPathValue = null
    }
  }

  percent() {
    if (!this.total) return null
    return Math.min(100, (this.done * 100) / this.total)
  }

  rate() {
    const seconds = (Date.now() - this.startedAt) / 1000
    return seconds > 0 ? this.done / seconds : 0
  }

  eta(rate) {
    if (!this.total || rate <= 0) return null
    return Math.max(0, (this.total - this.done) / rate)
  }

  emitMilestones(percent, rate, eta) {
    if (percent === null) return
    while (this.milestoneIndex < this.milestones.length && percent >= this.milestones[this.milestoneIndex]) {
      const hit = this.milestones[this.milestoneIndex]
      this.milestoneIndex += 1
      const parts = [MARKER, `${Math.trunc(hit)}%`, `${fmtRate(rate)}${this.unit}/s`, `eta=${fmtSeconds(eta)}`]
      if (this.label) parts.push(`label=${this.label}`)
      if (this.tty) safeWrite(this.stream, '\n')
      safeWrite(this.stream, `${parts.join(' ')}\n`)
    }
  }

  render(percent, rate, eta, note) {
    // 开头 0.25 秒不画条：首帧 elapsed 可能是 0，会打出一条 0.00 it/s 的噪声。
    const elapsed = (Date.now() - this.startedAt) / 1000
    if (elapsed < 0.25 && (percent === null || percent < 100)) return

    if (!this.tty) {
      const now = Date.now()
      if (now - this.lastPrintAt < this.intervalMs) return
      this.lastPrintAt = now
    }

    const speed = `${fmtRate(rate)} ${this.unit}/s`
    let left
    if (percent === null) {
      left = `[${String(this.done).padStart(8)} ${this.unit}] ${speed.padStart(12)}`
    } else {
      const filled = Math.round((this.width * percent) / 100)
      const bar = '#'.repeat(filled) + '-'.repeat(this.width - filled)
      left = `[${String(Math.trunc(percent)).padStart(3)}%] ${bar} ${speed.padStart(12)} ETA ${fmtSeconds(eta)}`
    }

    const tail = []
    if (this.label) tail.push(this.label)
    if (note) tail.push(String(note))
    const line = tail.length > 0 ? `${left} | ${tail.join(' ')}` : left

    safeWrite(this.stream, this.tty ? `\r${line}` : `${line}\n`)
  }

  update(n = null, note = '') {
    this.done = n === null || n === undefined ? this.done + 1 : Math.trunc(Number(n))
    const percent = this.percent()
    const rate = this.rate()
    const eta = this.eta(rate)
    this.emitMilestones(percent, rate, eta)
    this.render(percent, rate, eta, note)
    this.publish('running', percent, note)
    return this
  }

  tick(note = '') {
    return this.update(null, note)
  }

  close(note = '', state = null) {
    if (this.closed) return this
    this.closed = true

    const seconds = (Date.now() - this.startedAt) / 1000
    const rate = seconds > 0 ? this.done / seconds : 0
    const complete = this.total !== null && this.done >= this.total

    const finalState = state ?? (complete || this.total === null ? 'done' : 'cancelled')
    this.publish(finalState, complete ? 100 : this.percent(), note)

    if (this.tty) {
      safeWrite(this.stream, '\r')
    } else if (complete) {
      // 只有真的跑满才打 100%：中途 break 时打 100% 会让 agent 误报完成。
      const parts = [MARKER, '100%', `${fmtRate(rate)}${this.unit}/s`, `elapsed=${fmtSeconds(seconds)}`]
      if (this.label) parts.push(`label=${this.label}`)
      safeWrite(this.stream, `${parts.join(' ')}\n`)
    }

    const head = complete || this.total === null
      ? `完成 ${this.done} ${this.unit}`
      : `中止于 ${this.done}/${this.total} ${this.unit}`
    let summary = `${head} · 耗时 ${fmtSeconds(seconds)} · 平均 ${fmtRate(rate)} ${this.unit}/s`
    if (this.label) summary += ` · ${this.label}`
    if (note) summary += ` · ${note}`
    safeWrite(this.stream, `${summary}\n`)
    return this
  }
}

/**
 * 包住可迭代对象逐项推进度；`break` 或抛错时也会收尾。
 */
export function* track(iterable, { label = '', total = null, unit = 'it', ...rest } = {}) {
  let size = total
  if (size === null || size === undefined) {
    size = typeof iterable?.length === 'number' ? iterable.length : null
  }
  const p = new Progress({ total: size, label, unit, ...rest })
  let index = 0
  try {
    for (const item of iterable) {
      index += 1
      p.update(index)
      yield item
    }
  } catch (error) {
    // 真异常 → failed；提前 break 只走 finally，记 cancelled。
    p.close('', 'failed')
    throw error
  } finally {
    p.close()
  }
}
