"""精确分析 PDF 渲染图中表格单元格的文本垂直位置。

检测水平线 + 竖直线 → 重构单元格网格 → 逐单元格输出文本像素块
相对单元格中心的垂直偏移，并输出单元格内文本块的起止位置。
"""
import sys
from PIL import Image
import numpy as np

def analyze_page(path):
    img = Image.open(path).convert('RGB')
    a = np.asarray(img).astype(int)
    h, w, _ = a.shape
    # 网格线 #cbd5e1 ≈ (203,213,225)
    is_line = (np.abs(a[:, :, 0] - 203) < 45) & (np.abs(a[:, :, 1] - 213) < 45) & (np.abs(a[:, :, 2] - 225) < 45) & (a[:, :, 0] > a[:, :, 2] - 30)
    dark = (a.sum(axis=2) < 420)  # 文本像素（含彩色粗体）

    def cluster(idxs, gap=2):
        groups = []
        for r in idxs:
            if groups and r - groups[-1][-1] <= gap:
                groups[-1].append(r)
            else:
                groups.append([r])
        return [int(np.mean(g)) for g in groups]

    # 水平线：整行灰色占比 > 35%
    hline_rows = np.where(is_line.sum(axis=1) / w > 0.35)[0]
    hlines = cluster(hline_rows)
    # 竖直线：整列灰色占比 > 35%（限制在表格区域内）
    if len(hlines) >= 2:
        top, bot = hlines[0], hlines[-1]
        region = is_line[top:bot, :]
        vline_cols = np.where(region.sum(axis=0) / (bot - top) > 0.35)[0]
    else:
        vline_cols = np.array([])
    vlines = cluster(vline_cols)

    print(f"\n=== {path.split(chr(92))[-1]} (h={h}, w={w}) ===")
    print(f"水平线 {len(hlines)} 条 | 竖直线 {len(vlines)} 条: {vlines}")

    # 逐单元格分析（跳过表头第一行后续单独看）
    for i in range(len(hlines) - 1):
        top, bot = hlines[i], hlines[i + 1]
        rh = bot - top
        if rh < 10 or rh > 260:
            continue
        cells = []
        for j in range(len(vlines) - 1):
            cl, cr = vlines[j] + 2, vlines[j + 1] - 2
            if cr - cl < 15:
                continue
            seg = dark[top + 3:bot - 3, cl:cr]
            if seg.sum() < 20:
                cells.append((j, None, None))
                continue
            rr = np.where(seg.sum(axis=1) > 0)[0]
            t_top, t_bot = int(rr[0]), int(rr[-1])
            off = (t_top + t_bot) / 2 - rh / 2
            cells.append((j, t_top, t_bot))
            # 只输出偏差明显的单元格（>行高12% 或 >6px）
            if abs(off) > max(6, rh * 0.12):
                print(f"  行[{top},{bot}]h={rh} 列{vlines[j]}-{vlines[j+1]} 文本[{t_top},{t_bot}] 偏移{off:+.0f}px ({off/rh*100:+.0f}%)")
        # 该行所有有内容单元格的偏移概览
        offs = [((t + b) / 2 - rh / 2, j) for j, t, b in cells if t is not None]
        if offs:
            s = ' '.join(f"c{j}:{o:+.0f}" for o, j in offs)
            print(f"  行[{top},{bot}]h={rh} 概览: {s}")

if __name__ == '__main__':
    for p in sys.argv[1:]:
        analyze_page(p)
