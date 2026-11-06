/**
 * 零依赖自测：`node test/smoke.mjs`
 *
 * 覆盖四块：
 *   1. 配置解析（默认值 + 坏值必须抛错）
 *   2. 提示段落（中英文、里程碑跟着配置走、禁用时为空）
 *   3. 插件挂载（假 ctx 捕获 section、助手文件真的铺出去、激活快照可读）
 *   4. Node 助手能跑出 `@@PROGRESS` 里程碑
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgDir = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')

let passed = 0
const failures = []

function check(label, condition) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(label)
  console.error(`FAIL ${label}`)
}

function throws(label, fn) {
  try {
    fn()
  } catch {
    passed += 1
    return
  }
  failures.push(label)
  console.error(`FAIL ${label} (没有抛错)`)
}

const { resolveConfig } = await import(pathToFileURL(join(pkgDir, 'lib/config.js')).href)
const { buildSection } = await import(pathToFileURL(join(pkgDir, 'lib/section.js')).href)

// ── 1. 配置 ────────────────────────────────────────────────────────────
const defaults = resolveConfig({})
check('默认启用', defaults.enabled === true)
check('默认里程碑', JSON.stringify(defaults.milestones) === '[10,25,50,75,90]')
check('默认语言 zh', defaults.language === 'zh')
check('默认 order', defaults.order === 9200)

check('字符串数字可解析', resolveConfig({ minSeconds: '45' }).minSeconds === 45)
check('里程碑字符串可解析', JSON.stringify(resolveConfig({ milestones: '5, 50 ,95' }).milestones) === '[5,50,95]')
check('里程碑会去重排序', JSON.stringify(resolveConfig({ milestones: [50, 10, 50] }).milestones) === '[10,50]')

throws('未知语言要抛错', () => resolveConfig({ language: 'fr' }))
throws('里程碑越界要抛错', () => resolveConfig({ milestones: [0, 10] }))
throws('里程碑非整数要抛错', () => resolveConfig({ milestones: ['x'] }))
throws('空里程碑要抛错', () => resolveConfig({ milestones: [] }))
throws('order 越界要抛错', () => resolveConfig({ order: 5 }))
throws('非布尔 enabled 要抛错', () => resolveConfig({ enabled: 'maybe' }))

// ── 2. 提示段落 ─────────────────────────────────────────────────────────
const helpers = { helperDir: 'C:\\fake\\dir', psHelperPath: 'C:\\fake\\dir\\progress.ps1', mjsUrl: 'file:///C:/fake/dir/progress.mjs' }
const zh = buildSection(resolveConfig({}), helpers)
check('中文段落含标题', zh.includes('脚本进度'))
check('中文段落含真实助手路径', zh.includes('C:\\fake\\dir'))
check('中文段落含里程碑标记', zh.includes('@@PROGRESS'))
check('中文段落列出五个里程碑', zh.includes('10 / 25 / 50 / 75 / 90'))
check('中文段落要求后台跑', zh.includes('run_in_background'))
check('中文段落要求逐条回报', zh.includes('一条里程碑一行'))

const custom = buildSection(resolveConfig({ milestones: [5, 40, 95] }), helpers)
check('里程碑跟着配置走', custom.includes('5 / 40 / 95') && custom.includes('@@PROGRESS 40%'))

const en = buildSection(resolveConfig({ language: 'en' }), helpers)
check('英文段落生效', en.includes('Script progress') && !en.includes('脚本进度'))

const quiet = buildSection(resolveConfig({ reportInChat: false }), helpers)
check('关闭回报时不写逐条回报', !quiet.includes('一条里程碑一行'))

const withCli = buildSection(resolveConfig({}), { ...helpers, cliPath: 'C:\\fake\\dsh-progress.mjs' })
check('装了 task-progress 时给出包装器用法', withCli.includes('DSH_PROGRESS_CLI'))
check('明确禁止为上报另写脚本', withCli.includes('不要另写上报脚本'))
check('没装时不提包装器', !zh.includes('DSH_PROGRESS_CLI'))

// ── 3. 插件挂载 ─────────────────────────────────────────────────────────
const plugin = await import(pathToFileURL(join(pkgDir, 'index.js')).href)
check('插件名', plugin.name === 'script-progress')
check('只注入 systemPrompt', JSON.stringify(plugin.inject) === '["systemPrompt"]')

const helperDir = mkdtempSync(join(tmpdir(), 'dsp-smoke-'))
let captured
const ctx = {
  effect: (fn) => fn(),
  systemPrompt: {
    section: (section) => {
      captured = section
      return () => {}
    },
  },
}
plugin.apply(ctx, { enabled: true, helperDir })

check('section 已注册', captured !== undefined)
check('section 名字', captured?.name === 'progress:script')
check('section 顺序', captured?.order === 9200)
check('section 关闭插值', captured?.interpolate === false)
check('section 有正文', (captured?.text()?.length ?? 0) > 300)

const seeded = readdirSync(helperDir).sort()
check('助手文件已铺出', ['progress.mjs', 'progress.ps1', 'progress.py'].every((f) => seeded.includes(f)))
check('铺出后带版本戳', seeded.includes('.version'))

const status = JSON.parse(readFileSync(join(helperDir, 'last-activation.json'), 'utf8'))
const pkgVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version
check('激活快照版本跟随 package.json', status.version === pkgVersion)
check('激活快照无 seed 错误', status.seedError === null)

const disabled = plugin.apply(
  { effect: (fn) => fn(), systemPrompt: { section: (s) => { captured = s; return () => {} } } },
  { enabled: false, helperDir },
)
check('禁用时正文为空', captured.text() === '')
void disabled

// ── 4. Node 助手 ────────────────────────────────────────────────────────
const probeDir = mkdtempSync(join(tmpdir(), 'dsp-probe-'))
const probe = join(probeDir, 'probe.mjs')
writeFileSync(
  probe,
  `const { track } = await import(${JSON.stringify(pathToFileURL(join(pkgDir, 'assets/progress.mjs')).href)})\n` +
    `for (const _ of track(Array.from({ length: 40 }), { label: 'probe', intervalMs: 0 })) {}\n`,
  'utf8',
)

// 关掉 DSH 进度通道再跑：自测不该往用户会话的进度目录里写东西。
const run = spawnSync(process.execPath, [probe], {
  encoding: 'utf8',
  env: { ...process.env, DSH_PROGRESS_DIR: '' },
})
const err = `${run.stdout ?? ''}${run.stderr ?? ''}`
check('Node 助手跑出 100% 里程碑', err.includes('@@PROGRESS 100%'))
check('Node 助手跑出汇总行', err.includes('完成 40 it'))

// ── 5. DSH 进度通道（dsh-task-progress 协议） ───────────────────────────
const channel = mkdtempSync(join(tmpdir(), 'dsp-channel-'))
const runUi = spawnSync(process.execPath, [probe], {
  encoding: 'utf8',
  env: { ...process.env, DSH_PROGRESS_DIR: channel },
})
const written = readdirSync(channel)
check('写出了一个任务文件', written.length === 1 && written[0].endsWith('.jsonl'))

const lines = readFileSync(join(channel, written[0] ?? 'missing.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const last = lines[lines.length - 1] ?? {}
check('末行 state=done', last.state === 'done')
check('末行 pct=100', last.pct === 100)
check('末行带计数', last.done === 40 && last.total === 40)
check('末行带 task id', /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(String(last.task)))
check('末行带时间戳', Number.isFinite(last.at))
void runUi

// ── 结果 ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败，${passed} 项通过`)
  process.exit(1)
}
console.log(`全部通过：${passed} 项`)
