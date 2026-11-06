**中文** ｜ [English](README.en.md)

# dsh-script-progress · 脚本进度条

让 agent 写长任务脚本时**必须**带上进度条（百分比 / 速度 / ETA），并在 **10 / 25 / 50 / 75 / 90%**
这些里程碑把进展回报到聊天里。

解决的问题：跑一个三分钟的下载或转码时，模型在等、你也在等，谁都不知道还剩多久 ——
只能盯着一个不动的转圈。这个插件把「进度」变成脚本的硬性输出，把「回报」变成模型的硬性动作。

## 它做了三件事

| 机制 | 位置 | 说明 |
|---|---|---|
| 提示段落 | 系统提示 `progress:script`（order 9200） | 强制条款：什么算长任务、脚本要输出什么、怎么跑、怎么报 |
| 进度助手 | `$DSH_HOME/script-progress/` | `progress.py` / `progress.ps1` / `progress.mjs`，直接 import 就有进度条 |
| 里程碑约定 | `@@PROGRESS 25% 12.4it/s eta=00:03 label=下载` | 机器可读的一行，agent 从抓到的输出里认这个前缀 |

模型不用每次重写进度条 —— 提示段落里直接给出**真实的绝对路径**（运行时渲染），
所以它写 `import sys; sys.path.insert(0, r"...")` 就能拿到。

## 安装

从 GitHub 装（仓库本身就是可安装的 bundle）：

```bash
dsh plugin --profile web add github:Elosiad/dsh-script-progress
```

本地目录（开发时）：

```bash
dsh plugin --profile web add link:/path/to/dsh-script-progress
```

装完重启一次 DSH。是否真的激活，看这个文件：

```
%USERPROFILE%\.dsh\script-progress\last-activation.json
```

## 配置

写在插件行的 `config:` 里，改完重新加载插件生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉时该段落渲染成空字符串 |
| `minSeconds` | `20` | 超过多少秒的脚本才算「长任务」（只影响措辞里的阈值） |
| `milestones` | `[10,25,50,75,90]` | 里程碑百分比，1–99 的整数；100 由助手自动补 |
| `reportInChat` | `true` | 是否要求逐条回报；关掉则只在任务结束时汇总 |
| `language` | `zh` | 段落语言，`zh` / `en` |
| `order` | `9200` | 段落插入位置；narration 主段是 8950、尾部提醒是 10150 |
| `helperDir` | 空 | 助手目录覆盖；留空 = `$DSH_HOME/script-progress` |
| `debug` | `false` | 把渲染出的段落原文写到 `section.txt` |

坏配置会**当场抛错**（插件不激活、日志里有明确原因），不会静默回退成默认值。

## 用法

### Python

```python
import sys
sys.path.insert(0, r"C:\Users\you\.dsh\script-progress")
from progress import track

for item in track(items, label="下载"):
    fetch(item)

# 或者手动控制
from progress import Progress
p = Progress(total=len(urls), label="下载", unit="req")
for url in urls:
    p.update(note=url)
p.close()
```

### PowerShell

```powershell
. "C:\Users\you\.dsh\script-progress\progress.ps1"

ForEach-WithProgress -Items $urls -Label '下载' -Unit 'req' -Process {
    param($url)
    Invoke-WebRequest $url | Out-Null
}
```

### Node

```js
const { track, Progress } = await import(
  'file:///C:/Users/you/.dsh/script-progress/progress.mjs'
)

for (const item of track(items, { label: '下载' })) {
  await fetch(item)
}
```

## 输出长这样

被 agent 捉到的输出（非 TTY）每 0.5 秒一行，里程碑单独占一行：

```
[ 15%] ###-------------------     120 it/s ETA 00:01 | 下载
@@PROGRESS 25% 123it/s eta=00:01 label=下载
[ 44%] ##########------------     119 it/s ETA 00:01 | 下载
@@PROGRESS 50% 121it/s eta=00:01 label=下载
@@PROGRESS 100% 118 it/s elapsed=00:02 label=下载
完成 200 it · 耗时 00:02 · 平均 118 it/s · 下载
```

在真实终端里则是原地刷新的 `\r` 动画条。

中途 `break`、`return` 或抛异常时收尾打的是「中止于 21/100 it」，**绝不会谎报 100%**
—— 否则模型会向你宣布一个根本没跑完的任务已经完成。

## 跟 dsh-task-progress 的关系

装了 [dsh-task-progress](https://github.com/chen8923/dsh-task-progress) 时，助手会检测
`DSH_PROGRESS_DIR`，把同一条进度**再写一份** JSON 行进去，于是：

- **界面**：悬浮窗 / 右侧栏 tab 实时画进度条；
- **聊天**：模型按 `@@PROGRESS` 行回报里程碑。

两者互不替代，也不用你额外做什么 —— 装了那个插件，这个能力自动接上。

## 设计取舍

- **进度条只用 ASCII**（`#` / `-`）：Windows 下 stdout 被重定向时编码常是 cp936，
  画 `█` 会 `UnicodeEncodeError` 把用户的脚本炸掉。
- **写失败一律吞掉**：进度是锦上添花，不能成为脚本的崩溃源。
- **PowerShell 助手是纯 ASCII 文件**：PowerShell 5.1 在没有 BOM 时按 ANSI/GBK
  读脚本，UTF-8 中文注释会被读成乱码，甚至引入引号把语法搞崩。
- **非 TTY 节流**：被 agent 捉输出时不刷 `\r`，改为按间隔出整行，免得输出撑爆上下文。
- **零依赖**：不 import `@deepseek-ai/schemastery`。profile 里的插件是 junction
  挂载的，Node 会按真实路径（`D:\codex\...`）解析依赖，必然找不到宿主那份包。
- **开头的 0.25 秒不画条**：Windows 时钟分辨率 15.6ms，首帧 `elapsed` 可能是 0，
  会打出一条 `0.00 it/s` 的噪声。

## 已知边界

- **前台阻塞时无法中途回报**：工具执行期间 agent 循环是阻塞的，模型读不到任何东西。
  所以条款要求长任务放后台跑 —— 这是「能不能报进度」的前提，不是风格建议。
- **模型仍可能偷懒**：这是提示词层面的约束，不是强制拦截。
- **助手目录会被版本戳覆盖**：包升级后首次激活会把三份助手刷成新版；
  想改就设 `helperDir` 指到自己那份。

## 自测

```
node test\smoke.mjs
```

42 项：配置解析、段落渲染（中英）、section 挂载、助手落盘、三语言助手实跑、
DSH 进度通道协议字段。

## 卸载

```bash
dsh plugin --profile web remove dsh-script-progress
```

`$DSH_HOME/script-progress/` 可以保留（无害），也可以整目录删掉。

## License

MIT
