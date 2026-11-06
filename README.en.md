[中文](README.md) ｜ **English**

# dsh-script-progress · script progress bars

Makes the agent give long-running scripts a real progress bar (percent / rate / ETA) and
report progress in chat at **10 / 25 / 50 / 75 / 90%**.

The problem: on a three-minute download or transcode, the model waits, you wait, and
nobody knows how long is left — you stare at a spinner that never changes. This plugin
turns "progress" into a hard requirement of the script, and "reporting" into a hard
action of the model.

## What it does

| Piece | Where | What it is |
|---|---|---|
| Prompt section | System prompt `progress:script` (order 9200) | The contract: what counts as a long task, what the script must print, how to run it, how to report |
| Helpers | `$DSH_HOME/script-progress/` | `progress.py` / `progress.ps1` / `progress.mjs` — import and you have a bar |
| Milestone line | `@@PROGRESS 25% 12.4it/s eta=00:03 label=download` | One machine-readable line the agent finds in captured output |

The model never has to rewrite a progress bar: the prompt section carries the **real
absolute path**, rendered at assembly time, so `import sys; sys.path.insert(0, r"...")`
just works.

## Install

From GitHub (the repo is itself an installable bundle):

```bash
dsh plugin --profile web add github:Elosiad/dsh-script-progress
```

From a local checkout (development):

```bash
dsh plugin --profile web add link:/path/to/dsh-script-progress
```

Restart DSH once afterwards. To check whether it really activated:

```
%USERPROFILE%\.dsh\script-progress\last-activation.json
```

## Configuration

Set on the plugin row's `config:`; reload the plugin to apply.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; off renders an empty section |
| `minSeconds` | `20` | What counts as a long task (wording only) |
| `milestones` | `[10,25,50,75,90]` | Milestone percentages, integers 1–99; the helper adds 100 |
| `reportInChat` | `true` | Report per milestone; off means one summary at the end |
| `language` | `zh` | Section language, `zh` / `en` |
| `order` | `9200` | Placement; narration's sections sit at 8950 and 10150 |
| `helperDir` | empty | Override the helper directory; empty = `$DSH_HOME/script-progress` |
| `debug` | `false` | Write the rendered section to `section.txt` |

An invalid value throws at activation with a readable message — it never silently falls
back to a default.

## Usage

### Python

```python
import sys
sys.path.insert(0, r"C:\Users\you\.dsh\script-progress")
from progress import track

for item in track(items, label="download"):
    fetch(item)

# or drive it by hand
from progress import Progress
p = Progress(total=len(urls), label="download", unit="req")
for url in urls:
    p.update(note=url)
p.close()
```

### PowerShell

```powershell
. "C:\Users\you\.dsh\script-progress\progress.ps1"

ForEach-WithProgress -Items $urls -Label 'download' -Unit 'req' -Process {
    param($url)
    Invoke-WebRequest $url | Out-Null
}
```

### Node

```js
const { track, Progress } = await import(
  'file:///C:/Users/you/.dsh/script-progress/progress.mjs'
)

for (const item of track(items, { label: 'download' })) {
  await fetch(item)
}
```

## What the output looks like

Captured output (not a TTY) prints one line every 0.5s, with milestones on their own line:

```
[ 15%] ###-------------------     120 it/s ETA 00:01 | download
@@PROGRESS 25% 123it/s eta=00:01 label=download
[ 44%] ##########------------     119 it/s ETA 00:01 | download
@@PROGRESS 50% 121it/s eta=00:01 label=download
@@PROGRESS 100% 118 it/s elapsed=00:02 label=download
done 200 it | took 00:02 | avg 118 it/s | download
```

On a real terminal it is an in-place `\r` bar instead.

A `break`, `return` or exception ends the row as `stopped at 21/100 it` — it **never
claims 100%**, because a model that does so announces a finished job that never finished.

## Division of labour: one makes it exist, one makes it visible

In one sentence: **this plugin makes progress *exist*;
[dsh-task-progress](https://github.com/chen8923/dsh-task-progress) makes it *visible*.**

| | This plugin | dsh-task-progress |
|---|---|---|
| Role | Producer | Display |
| Owns | How the script reports, how the model reports | Where the progress is drawn |
| Output | `@@PROGRESS` lines (for the model) + JSONL lines (for the UI) | Floating panel + the "Task progress" sidebar tab |
| Without it | The script still runs, but you know nothing about it | One line of text in chat; the UI spins forever |

There is exactly one connection point: the helper detects `DSH_PROGRESS_DIR` and feeds the
same progress to it, so once that plugin is installed there is nothing for you to do — the
UI lights up on its own.

**They do not replace each other**: this plugin draws no UI, and that one does not make any
script report progress — with a silent script it can only show an elapsed time.

## Design notes

- **ASCII-only bars** (`#` / `-`): on Windows a redirected stdout is often cp936, and
  drawing `█` raises `UnicodeEncodeError`, killing the user's script.
- **Every write is best-effort**: progress is a nicety and must never be a crash source.
- **The PowerShell helper is an ASCII-only file**: PowerShell 5.1 decodes scripts as
  ANSI/GBK when there is no BOM, so UTF-8 comments become mojibake and can even inject a
  quote that breaks parsing.
- **Throttled when not a TTY**: no `\r` when captured; whole lines at an interval instead,
  so output cannot flood the context.
- **Zero dependencies**: no `@deepseek-ai/schemastery` import. Profile plugins are mounted
  through a junction, so Node resolves dependencies from the real path (`D:\codex\...`)
  and can never find the host's copy.
- **No bar in the first 0.25s**: Windows' clock resolution is 15.6ms, so the first frame
  can have `elapsed == 0` and print a `0.00 it/s` line.

## Known limits

- **No mid-run report while blocked**: the agent loop is blocked during a tool call, so
  the model cannot read anything. The contract therefore requires long jobs to run in the
  background — that is the precondition for reporting, not a style preference.
- **The model can still slack off**: this is a prompt-level constraint, not enforcement.
- **The helper directory is refreshed by version stamp**: the first activation after a
  version bump overwrites the three helpers; point `helperDir` elsewhere if you fork them.

## Tests

```
node test\smoke.mjs
```

42 checks: config parsing, section rendering (zh/en), section mounting, helper seeding,
all three helpers actually running, and the DSH progress-channel protocol fields.

## Uninstall

```bash
dsh plugin --profile web remove dsh-script-progress
```

`$DSH_HOME/script-progress/` can stay (harmless) or be deleted.

## License

MIT
