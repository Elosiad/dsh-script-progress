"""示例：一个跑十几秒的假任务，演示进度条 + 里程碑。

    python examples/demo.py

脚本本身没什么用，重点是看输出长什么样：
    [ 42%] ##########------------     12.4 it/s ETA 00:03 | 演示下载
    @@PROGRESS 50% 12.4it/s eta=00:02 label=演示下载
"""

import os
import sys
import time

_HELPER_DIR = os.path.join(os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh"), "script-progress")
sys.path.insert(0, _HELPER_DIR)
from progress import track  # noqa: E402

ITEMS = ["file-{:03d}".format(i) for i in range(120)]

for name in track(ITEMS, label="演示下载"):
    time.sleep(0.1)
