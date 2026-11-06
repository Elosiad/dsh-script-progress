/**
 * dsh-script-progress — 长任务脚本的进度纪律。
 *
 * 解决什么：跑一个几分钟的脚本时，模型在等、用户也在等，双方都不知道还剩多久。
 * 这个插件往系统提示里注册一段「强制」条款，要求模型在写任何长任务脚本时：
 *
 *   1. 脚本自带进度条：百分比 + 速度 + ETA；
 *   2. 在 10 / 25 / 50 / 75 / 90% 各打印一行 `@@PROGRESS ...` 里程碑；
 *   3. 放后台跑，每读到一条新里程碑就在正文里报一行。
 *
 * 同时把三份可直接 import 的进度助手（Python / PowerShell / Node）铺到
 * `$DSH_HOME/script-progress`，所以模型不用每次重新实现进度条 —— 提示段落里
 * 直接给出真实绝对路径。
 *
 * 只用两个公开扩展点：`systemPrompt.section()` 与文件系统。零依赖。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolveConfig } from './lib/config.js'
import { ensureHelpers, helperDirectory, packageVersion, writeSectionSnapshot, writeStatus } from './lib/helpers.js'
import { buildSection } from './lib/section.js'

/** Cordis 插件名（行配置没写 name 时用它）。 */
export const name = 'script-progress'

/** 只要 systemPrompt 服务即可；其余一律不走服务。 */
export const inject = ['systemPrompt']

/** 系统提示里这一段的名字，别和别的插件撞。 */
export const SECTION_NAME = 'progress:script'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * @param ctx - Cordis context，带 systemPrompt 服务。
 * @param config - patch 里 `config:` 的原始对象（未经 schema 校验）。
 */
export function apply(ctx, config) {
  const raw = config ?? {}

  /** 每次装配现算：改 patch 后重新加载即可生效，不需要额外缓存。 */
  const settings = () => resolveConfig(raw)

  // 激活时就校验一次：坏配置当场失败，而不是让每一轮提示都静默少一段。
  const mounted = settings()

  let helperDir
  let seedError
  try {
    helperDir = ensureHelpers({ packageDir: PACKAGE_DIR, override: mounted.helperDir })
  } catch (error) {
    // 铺文件失败不该让插件消失：仍然挂上提示，只是助手路径可能不可用。
    seedError = error
    helperDir = helperDirectory(mounted.helperDir)
  }

  const helpers = {
    helperDir,
    psHelperPath: join(helperDir, 'progress.ps1'),
    mjsUrl: pathToFileURL(join(helperDir, 'progress.mjs')).href,
  }

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: settings().order,
        interpolate: false,
        text: () => {
          try {
            const current = settings()
            return current.enabled ? buildSection(current, helpers) : ''
          } catch {
            // 提示段落拼装失败绝不能把整个请求带崩。
            return ''
          }
        },
      }),
    'script-progress.section()',
  )

  // 激活快照：插件跑没跑起来、渲染多少字、助手铺到哪，一文件看全。
  const sectionChars = mounted.enabled ? buildSection(mounted, helpers).length : 0
  writeStatus(helperDir, {
    plugin: 'dsh-script-progress',
    version: packageVersion(PACKAGE_DIR),
    activatedAt: new Date().toISOString(),
    enabled: mounted.enabled,
    helperDir,
    sectionChars,
    milestones: mounted.milestones,
    language: mounted.language,
    minSeconds: mounted.minSeconds,
    order: mounted.order,
    seedError: seedError === undefined ? null : String(seedError?.message ?? seedError),
  })

  if (mounted.debug) {
    // 段落原文落盘一份，方便肉眼核对提示到底长什么样。
    writeSectionSnapshot(helperDir, mounted.enabled ? buildSection(mounted, helpers) : '')
  }
}
