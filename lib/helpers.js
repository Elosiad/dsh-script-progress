/**
 * 把随包的三份进度助手铺到用户目录，供生成的脚本直接 import。
 *
 * 目标目录：`$DSH_HOME/script-progress`（默认 ~/.dsh/script-progress）。
 * 用版本戳 `.version` 判断是否要覆盖：包升级后第一次激活会把文件刷成新版，
 * 版本没变就不重写 —— 免得用户手改过的副本被悄悄冲掉。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 随包发布的助手文件。 */
export const HELPER_FILES = Object.freeze(['progress.py', 'progress.ps1', 'progress.mjs'])

const STAMP_FILE = '.version'
const STATUS_FILE = 'last-activation.json'

/** `$DSH_HOME`，没设就退回 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 助手目录；`override` 非空时优先（配置项 helperDir）。 */
export function helperDirectory(override) {
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(dshHome(), 'script-progress')
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 从包自己的 package.json 读版本号；读不到就退化成 `0.0.0`。 */
export function packageVersion(packageDir) {
  const raw = readText(join(packageDir, 'package.json'))
  if (!raw) return '0.0.0'
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 确保助手文件就位并返回目录。
 *
 * @param options.packageDir - 插件包根目录（assets/ 所在处）。
 * @param options.override - 配置里的 helperDir。
 * @returns 助手目录的绝对路径。
 */
export function ensureHelpers({ packageDir, override }) {
  const dir = helperDirectory(override)
  mkdirSync(dir, { recursive: true })

  const version = packageVersion(packageDir)
  const stamped = readText(join(dir, STAMP_FILE))
  const missing = HELPER_FILES.some((file) => !existsSync(join(dir, file)))
  const stale = stamped === undefined || stamped.trim() !== version

  if (missing || stale) {
    for (const file of HELPER_FILES) {
      copyFileSync(join(packageDir, 'assets', file), join(dir, file))
    }
    writeFileSync(join(dir, STAMP_FILE), `${version}\n`, 'utf8')
  }

  return dir
}

/**
 * 落一份激活快照。插件是否真的跑起来了、渲染了多少字、助手在哪，
 * 全在这一个文件里 —— 排查时不用去翻宿主日志。
 */
export function writeStatus(dir, payload) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, STATUS_FILE), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    // 写不出来不影响插件本体。
  }
}

/** 调试用：把渲染出来的段落原文落盘，方便肉眼核对提示到底长什么样。 */
export function writeSectionSnapshot(dir, text) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'section.txt'), `${text}\n`, 'utf8')
  } catch {
    // 同上，失败不影响本体。
  }
}
