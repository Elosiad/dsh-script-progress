/**
 * 系统提示段落文本 —— 这个插件的本体。
 *
 * 装配时机：每个模型步骤都会重新渲染一次（text 是函数），所以 patch 里改
 * config、或改环境里的 helper 目录，都不用重启插件。
 *
 * 写法上刻意不引入任何字面反斜杠：Windows 路径由调用方拼好后插进来，
 * 免得模板字符串把 `\p` 这类转义吃掉。
 */

/** 输出一条进度行 / 一段里程碑说明。 */
function zhLines(settings, helpers) {
  const milestoneText = settings.milestones.join(' / ')
  const example = settings.milestones[Math.min(1, settings.milestones.length - 1)]
  const lines = [
    '## 脚本进度（强制）',
    '',
    `凡可能跑超过 ${settings.minSeconds} 秒的脚本 —— 循环、批处理、下载、爬取、转码、遍历目录、跑测试 —— 都必须让人看得出它跑到哪儿了、还剩多久。`,
    '',
    '**脚本里必须有**',
    '',
    '1. 实时进度行，含百分比 + 速度 + ETA：',
    '   `[ 42%] ##########---------- 12.4 it/s ETA 00:03 | 下载`',
    '   速度按任务选单位（it/s、MB/s、行/s、请求/s）。',
    `2. 每到一个里程碑（${milestoneText}%）单独打印一行机器可读标记，独占一行、不加前后缀：`,
    `   \`@@PROGRESS ${example}% 12.4it/s eta=00:03 label=下载\``,
    '',
    '**直接用共享助手，别每次重写**（已经在磁盘上，不需要创建）',
    '',
    'Python：',
    '```python',
    `import sys; sys.path.insert(0, r"${helpers.helperDir}")`,
    'from progress import track',
    '',
    'for item in track(items, label="下载"):   # 自动进度条 + 里程碑',
    '    ...',
    '```',
    '',
    `PowerShell 用 \`${helpers.psHelperPath}\` 里的 \`ForEach-WithProgress\`；Node 用 \`${helpers.mjsUrl}\` 导出的 \`track\` / \`Progress\`。`,
    '',
    '**和 dsh-task-progress 一起用时**：`DSH_PROGRESS_DIR` 存在时，助手会自动把进度同时写进 DSH 的进度通道（界面上实时可见），不要在它外面再套一层 `dsh-progress run` —— 那层包装只留给改不了脚本的命令。',
  ]

  lines.push(
    '',
    '**怎么跑**',
    '',
    '长任务放后台跑（run_in_background），不要前台干等 —— 前台等着的时候你既看不到进度也报不出来。每轮取输出时找 `@@PROGRESS` 行。',
  )

  if (settings.reportInChat) {
    lines.push(
      '',
      '**怎么报**',
      '',
      '每读到一条新的 `@@PROGRESS` 里程碑，就在正文里写一行：',
      '`进度 50% · 12.4 it/s · 剩余约 3 分钟`',
      '',
      '一条里程碑一行，不解释、不重复；没有新里程碑就别出声。任务结束报总数、总耗时、平均速度。',
    )
  } else {
    lines.push(
      '',
      '里程碑不进正文，任务结束时一次性汇总：总数、总耗时、平均速度、失败项。',
    )
  }

  return lines
}

function enLines(settings, helpers) {
  const milestoneText = settings.milestones.join(' / ')
  const example = settings.milestones[Math.min(1, settings.milestones.length - 1)]
  const lines = [
    '## Script progress (mandatory)',
    '',
    `Any script that may run longer than ${settings.minSeconds} seconds — a loop, batch, download, crawl, transcode, directory walk, or test suite — must show how far it has got and how much is left.`,
    '',
    '**Every such script must have**',
    '',
    '1. A live progress line with percentage + rate + ETA:',
    '   `[ 42%] ##########---------- 12.4 it/s ETA 00:03 | download`',
    '   Pick the rate unit that fits the job (it/s, MB/s, lines/s, req/s).',
    `2. At each milestone (${milestoneText}%) print one machine-readable line, on its own line, with no prefix or suffix:`,
    `   \`@@PROGRESS ${example}% 12.4it/s eta=00:03 label=download\``,
    '',
    '**Use the shared helper, do not rewrite it** (it is already on disk; do not create it)',
    '',
    'Python:',
    '```python',
    `import sys; sys.path.insert(0, r"${helpers.helperDir}")`,
    'from progress import track',
    '',
    'for item in track(items, label="download"):   # bar + milestones',
    '    ...',
    '```',
    '',
    `PowerShell: \`ForEach-WithProgress\` from \`${helpers.psHelperPath}\`. Node: \`track\` / \`Progress\` from \`${helpers.mjsUrl}\`.`,
    '',
    '**With dsh-task-progress installed**: when `DSH_PROGRESS_DIR` is set the helper also publishes to DSH\'s progress channel, so the UI updates live. Do not wrap the command in `dsh-progress run` on top of it — that wrapper is for commands whose script you cannot change.',
    '**How to run it**',
    '',
    'Run long jobs in the background (run_in_background) instead of blocking on them — while you block you can neither see the progress nor report it. Look for `@@PROGRESS` lines each time you read output.',
  ]

  if (settings.reportInChat) {
    lines.push(
      '',
      '**How to report**',
      '',
      'For each new `@@PROGRESS` milestone, write one line in your reply:',
      '`progress 50% · 12.4 it/s · ~3 min left`',
      '',
      'One line per milestone — no explanation, no repeats, and stay quiet when nothing new arrived. At the end report the total, the wall time, and the average rate.',
    )
  } else {
    lines.push(
      '',
      'Milestones stay out of the reply; summarise once at the end: total, wall time, average rate, failures.',
    )
  }

  return lines
}

/**
 * 渲染段落正文。
 *
 * @param settings - `resolveConfig()` 的结果。
 * @param helpers - `{ helperDir, psHelperPath, mjsUrl }`。
 * @returns 以换行连接的 Markdown 文本。
 */
export function buildSection(settings, helpers) {
  const lines = settings.language === 'en' ? enLines(settings, helpers) : zhLines(settings, helpers)
  return lines.join('\n')
}
