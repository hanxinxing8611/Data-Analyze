import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import ExcelJS from 'exceljs';
import type { ReportMetaInput, SampleRecord } from '../types';
import { fmt } from '../utils/statistics';
import { applyWorkbookFont, FONT_STACK } from '../utils/font';
import {
  batchLabelOf,
  buildSummaryGroups,
  criteriaTextShort,
  isValidDevice,
  metricValue,
  verdictLabelOf,
  type ReportData,
} from './reportData';

/* ================= 分块截图 ================= */

export interface CapturedBlock {
  name: string;
  kind: string;
  canvas: HTMLCanvasElement;
  /** 分页断点（canvas 像素，相对块顶）：块内直接子元素与表格行的上边界，
   *  超高块分页时在断点处切开，实现整行换页、段落不在文字中间被截断 */
  breaks?: number[];
  /** 表头区域（canvas 像素，相对块顶）：仅单表格块记录，PDF 续页重复表头 */
  header?: { y: number; h: number };
}

/** 对报告纸张整体截图（scale=2 保证打印清晰度） */
export async function capturePaper(paperEl: HTMLElement): Promise<HTMLCanvasElement> {
  return html2canvas(paperEl, {
    scale: 2,
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
  });
}

/**
 * 表格分页断点行。
 * 汇总表每批次 3 行（冠军/中位/最优）为一组，组首行带 data-group-first 标记——
 * 仅在组首行处断页，批次信息（置于中位行）与组内行不被切开；
 * 普通表格（无分组标记）每一行都是合法断点。
 */
function rowBreakElements(el: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const table of Array.from(el.querySelectorAll<HTMLTableElement>('table'))) {
    const trs = Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr'));
    const groupFirsts = trs.filter((tr) => tr.hasAttribute('data-group-first'));
    rows.push(...(groupFirsts.length > 0 ? groupFirsts : trs));
  }
  return rows;
}

/** 按模板中的 [data-block] 元素切分整体截图，得到分块画布（表格块附行边界/表头） */
export function extractBlocks(
  paper: HTMLCanvasElement,
  paperEl: HTMLElement,
): CapturedBlock[] {
  const paperRect = paperEl.getBoundingClientRect();
  const scale = paper.width / paperRect.width;
  const blocks = Array.from(paperEl.querySelectorAll<HTMLElement>('[data-block]'));

  const result: CapturedBlock[] = [];
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    const y = Math.max(0, Math.round((r.top - paperRect.top) * scale));
    const h = Math.max(1, Math.round(r.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = paper.width;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(paper, 0, y, paper.width, h, 0, 0, paper.width, h);

    const block: CapturedBlock = {
      name: el.dataset.block || '',
      kind: el.dataset.blockKind || 'text',
      canvas,
    };

    /* 分页断点：块内直接子元素（标题/表格/注释段落）与表格行的上边界，
     * 其中表格行按 rowspan 分组取组首行——整组换页，合并单元格与注释不在中间被截断 */
    const breakEls: HTMLElement[] = [
      ...(Array.from(el.children) as HTMLElement[]),
      ...rowBreakElements(el),
    ];
    if (breakEls.length > 0) {
      block.breaks = breakEls
        .map((elm) =>
          Math.max(0, Math.round((elm.getBoundingClientRect().top - r.top) * scale)),
        )
        .sort((a, b) => a - b);
    }

    /* 表头区域（仅单表格块）：续页顶部重复表头，保证跨页表格可读 */
    const tables = el.querySelectorAll('table');
    if (tables.length === 1) {
      const thead = tables[0].querySelector('thead');
      if (thead) {
        const tr = thead.getBoundingClientRect();
        block.header = {
          y: Math.max(0, Math.round((tr.top - r.top) * scale)),
          h: Math.max(1, Math.round(tr.height * scale)),
        };
      }
    }

    result.push(block);
  }
  return result;
}

/* ================= 导出文件自动命名 ================= */

/** 剔除文件名非法字符（Windows 保留字符与控制符）并去首尾空白 */
function sanitizeNamePart(s: string | null | undefined): string {
  return (s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
}

/**
 * 报告导出文件自动命名：日期（YYMMDD）.汇报人-批次号vs批次号vs…-器件分析报告.<ext>
 * 示例：260822.晏广元-CB615W1vsCB306B1vsFB715B2vsYAN-器件分析报告.pdf
 * - 日期取报告日期（YYYY-MM-DD → 6 位 YYMMDD），缺失/非法时回退当天
 * - 批次号按报告顺序排列（基准批次在前，与表格/箱线图一致），批次号之间用 vs 连接
 * - 汇报人为空时省略该段（不产生悬挂连字符）；各段剔除文件名非法字符
 * - Excel 实际格式为 xlsx，扩展名用 .xlsx（避免 Excel 格式与扩展名不符警告）
 */
export function buildReportFileName(
  meta: Pick<ReportMetaInput, 'report_date' | 'reporter'>,
  batchIds: string[],
  ext: 'pdf' | 'xlsx',
): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(meta.report_date ?? '');
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const date6 = m
    ? `${m[1].slice(2)}${m[2]}${m[3]}`
    : `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const batchPart = batchIds
    .map((id) => sanitizeNamePart(batchLabelOf(id)))
    .filter(Boolean)
    .join('vs');
  const parts = [
    sanitizeNamePart(meta.reporter),
    batchPart,
    '器件分析报告',
  ].filter(Boolean);
  return `${date6}.${parts.join('-')}.${ext}`;
}

/* ================= PDF 封面与页脚 ================= */

/** A4 版面常量（分页、封面与页脚绘制共用） */
export const PDF_LAYOUT = {
  PW: 210, // 页宽（mm）
  PH: 297, // 页高（mm）
  FOOTER_RESERVE: 8, // 页脚保留区高度（mm），正文排版不越过此线
};

/** 封面/页脚绘制精度（px/mm，兼顾清晰度与文件体积） */
const COVER_PX_PER_MM = 6;

/**
 * 绘制 PDF 封面页画布（导出时置于首页，独占一页；预览不显示）：
 * 系统名 + 报告标题 + 蓝色装饰条 + 报告信息（汇报人/日期/批次/基准/统计口径）。
 * 参与批次过多时值区按「、」折行（每行 ≤150mm），首行带标签、续行留空。
 */
export function buildCoverBlock(meta: ReportMetaInput, data: ReportData): CapturedBlock {
  const PXMM = COVER_PX_PER_MM;
  const W = PDF_LAYOUT.PW * PXMM;
  const H = (PDF_LAYOUT.PH - PDF_LAYOUT.FOOTER_RESERVE) * PXMM;
  const mm = (v: number) => v * PXMM;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';

    /* 系统名（顶部小字） */
    ctx.fillStyle = '#94A3B8';
    ctx.font = `400 ${mm(4)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.fillText('器件验证数据分析系统', W / 2, mm(50));

    /* 报告标题 */
    ctx.fillStyle = '#0F172A';
    ctx.font = `700 ${mm(10.5)}px ${FONT_STACK}`;
    ctx.fillText('钙钛矿器件验证对比分析报告', W / 2, mm(76));

    /* 蓝色装饰条（与正文小标题蓝色块呼应） */
    ctx.fillStyle = '#2563EB';
    ctx.fillRect((W - mm(42)) / 2, mm(88), mm(42), mm(1.6));

    /* 报告信息：标签右对齐 + 值左对齐，整块水平居中 */
    const info: [string, string][] = [
      ['汇报人', meta.reporter?.trim() || '—'],
      ['汇报日期', meta.report_date || '—'],
      ['参与批次', `${data.totals.batches} 个：${data.groups.map((g) => g.batchId).join('、') || '—'}`],
    ];
    if (data.baseline) info.push(['基准批次', data.baseline.baselineBatchId]);
    info.push(
      ['测试记录', `${data.totals.samples} 条（其中反扫 ${data.totals.reverse} 条）`],
      ['有效测试记录', `${data.totals.valid}/${data.totals.reverse}（符合口径反扫数 / 反扫总数）`],
    );
    const labelFont = `400 ${mm(4.4)}px ${FONT_STACK}`;
    const valueFont = `500 ${mm(4.6)}px ${FONT_STACK}`;
    const wrapWidth = mm(150);
    const rows: [string, string][] = [];
    ctx.font = valueFont;
    for (const [label, value] of info) {
      if (ctx.measureText(value).width <= wrapWidth) {
        rows.push([label, value]);
        continue;
      }
      let line = '';
      let firstLine = true;
      for (const part of value.split('、')) {
        const next = line ? `${line}、${part}` : part;
        if (line && ctx.measureText(next).width > wrapWidth) {
          rows.push([firstLine ? label : '', line]);
          firstLine = false;
          line = part;
        } else {
          line = next;
        }
      }
      if (line) rows.push([firstLine ? label : '', line]);
    }
    ctx.font = labelFont;
    const labelW = Math.max(1, ...rows.map(([l]) => ctx.measureText(l).width));
    ctx.font = valueFont;
    const valueW = Math.max(1, ...rows.map(([, v]) => ctx.measureText(v).width));
    const gap = mm(6);
    const labelX = Math.max(0, (W - (labelW + gap + valueW)) / 2) + labelW;
    const valueX = labelX + gap;
    let rowY = mm(122);
    for (const [label, value] of rows) {
      if (label) {
        ctx.fillStyle = '#64748B';
        ctx.font = labelFont;
        ctx.textAlign = 'right';
        ctx.fillText(label, labelX, rowY);
      }
      ctx.fillStyle = '#1E293B';
      ctx.font = valueFont;
      ctx.textAlign = 'left';
      ctx.fillText(value, valueX, rowY);
      rowY += mm(13);
    }

    /* 底部生成说明 */
    ctx.fillStyle = '#94A3B8';
    ctx.font = `400 ${mm(3.6)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.fillText('本报告由器件验证数据分析系统生成', W / 2, mm(272));
  }
  return { name: 'cover', kind: 'cover', canvas };
}

/** 绘制页脚条画布：顶部浅灰细线 + 左侧报告日期 + 居中页码（第 X 页 / 共 Y 页） */
function buildFooterStrip(
  date: string | undefined,
  page: number,
  total: number,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = PDF_LAYOUT.PW * COVER_PX_PER_MM;
  c.height = PDF_LAYOUT.FOOTER_RESERVE * COVER_PX_PER_MM;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const W = c.width;
  const H = c.height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  /* 顶部细线（区分正文与页脚） */
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0.5);
  ctx.lineTo(W, 0.5);
  ctx.stroke();
  ctx.font = `400 22px ${FONT_STACK}`;
  ctx.fillStyle = '#94A3B8';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  if (date) ctx.fillText(date, 72, H / 2 + 3);
  ctx.textAlign = 'center';
  ctx.fillText(`第 ${page} 页 / 共 ${total} 页`, W / 2, H / 2 + 3);
  return c;
}

/* ================= PDF 导出 ================= */

/** 从块画布裁出 [yOffMm, yOffMm+sliceMm) 区域的切片画布 */
function sliceCanvas(
  block: CapturedBlock,
  yOffMm: number,
  sliceMm: number,
  pxPerMm: number,
): HTMLCanvasElement | null {
  const c = document.createElement('canvas');
  c.width = block.canvas.width;
  c.height = Math.max(1, Math.round(sliceMm * pxPerMm));
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(
    block.canvas,
    0,
    Math.round(yOffMm * pxPerMm),
    block.canvas.width,
    c.height,
    0,
    0,
    block.canvas.width,
    c.height,
  );
  return c;
}

/**
 * 将分块画布打包为 A4 PDF：
 * - 封面块（kind=cover）独占一页，其后内容从新页顶部开始；
 * - 常规块整体放入当前页（放不下则换页），正文高度不超过可用高度（底部预留页脚区）；
 * - 超页高的块按页切片，切片边界对齐分页断点（表格行/段落边界）实现整行换页；
 * - 跨页时在续页顶部重复表头（单表格块的 thead），避免文字在行中间被截断；
 * - 收尾为每页绘制页脚（报告日期 + 第 X 页 / 共 Y 页，封面页除外）。
 */
export function blocksToPdf(
  blocks: CapturedBlock[],
  filename: string,
  options: { footer?: { date?: string } } = {},
): void {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const { PW, PH, FOOTER_RESERVE } = PDF_LAYOUT;
  const USABLE = PH - FOOTER_RESERVE; // 正文可用高度（底部预留页脚区）
  const GAP = 4; // 块间距（mm）
  const HEADER_GAP = 1.5; // 续页表头与内容的间距（mm）

  let y = 0;
  let first = true;
  let pendingBreak = false; // 封面置入后待换页（下一块从新页顶部开始；封面为末块时不产生空白尾页）
  let coverPresent = false;

  for (const block of blocks) {
    if (block.canvas.height <= 1) continue;
    if (pendingBreak) {
      pdf.addPage();
      y = 0;
      first = true;
      pendingBreak = false;
    }
    const pxPerMm = block.canvas.width / PW;
    const hMm = block.canvas.height / pxPerMm;

    /* 封面：独占一页（置于页首），其后内容强制从新页开始 */
    if (block.kind === 'cover') {
      if (!first) {
        pdf.addPage();
        y = 0;
      }
      pdf.addImage(block.canvas.toDataURL('image/png'), 'PNG', 0, 0, PW, hMm);
      pendingBreak = true;
      coverPresent = true;
      continue;
    }

    if (hMm <= USABLE) {
      if (!first && y + hMm > USABLE) {
        pdf.addPage();
        y = 0;
      }
      pdf.addImage(block.canvas.toDataURL('image/png'), 'PNG', 0, y, PW, hMm);
      y += hMm + GAP;
    } else {
      // 超高块：从新页开始，切片边界对齐分页断点（整行/整段换页）
      if (!first) pdf.addPage();
      const headerMm = block.header ? block.header.h / pxPerMm : 0;
      const breaksPx = block.breaks ?? [];
      let yOffMm = 0;
      let sliceIndex = 0;
      while (yOffMm < hMm - 0.1) {
        // 首片可用整页高度；续片为重复表头预留空间
        const availMm =
          sliceIndex === 0 ? USABLE : USABLE - (headerMm > 0 ? headerMm + HEADER_GAP : 0);
        let sliceMm = Math.min(availMm, hMm - yOffMm);

        // 断点对齐：回退到可用范围内最大的分页断点，避免在行/段落中间切开
        const limitPx = (yOffMm + sliceMm) * pxPerMm;
        let cutPx = -1;
        for (const bp of breaksPx) {
          if (bp > limitPx + 0.5) break;
          if (bp > yOffMm * pxPerMm + 1) cutPx = bp;
        }
        if (cutPx > 0) sliceMm = cutPx / pxPerMm - yOffMm;
        if (sliceMm <= 0.1) sliceMm = Math.min(availMm, hMm - yOffMm); // 兜底

        const c = sliceCanvas(block, yOffMm, sliceMm, pxPerMm);
        if (sliceIndex > 0) pdf.addPage();
        let placeY = 0;
        if (sliceIndex > 0 && block.header && headerMm > 0) {
          const hc = sliceCanvas(block, block.header.y / pxPerMm, headerMm, pxPerMm);
          if (hc) {
            pdf.addImage(hc.toDataURL('image/png'), 'PNG', 0, 0, PW, headerMm);
            placeY = headerMm + HEADER_GAP;
          }
        }
        if (c) pdf.addImage(c.toDataURL('image/png'), 'PNG', 0, placeY, PW, sliceMm);
        yOffMm += sliceMm;
        y = placeY + sliceMm + GAP;
        sliceIndex++;
      }
    }
    first = false;
  }

  /* 页脚：每页底部保留区绘制报告日期与页码（封面页除外） */
  if (options.footer) {
    const total = pdf.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      if (coverPresent && i === 1) continue;
      const strip = buildFooterStrip(options.footer.date, i, total);
      if (!strip) continue;
      pdf.setPage(i);
      pdf.addImage(strip.toDataURL('image/png'), 'PNG', 0, PH - FOOTER_RESERVE, PW, FOOTER_RESERVE);
    }
  }

  pdf.save(filename);
}

export interface ExportPdfOptions {
  onProgress?: (msg: string) => void;
  /** 封面块（置于首页，独占一页；预览不显示） */
  cover?: CapturedBlock;
  /** 页脚（报告日期 + 页码，封面页不绘制） */
  footer?: { date?: string };
}

export async function exportPdf(
  paperEl: HTMLElement,
  filename: string,
  options: ExportPdfOptions = {},
): Promise<void> {
  options.onProgress?.('正在渲染报告页面…');
  const paper = await capturePaper(paperEl);
  options.onProgress?.('正在生成 PDF…');
  const blocks = extractBlocks(paper, paperEl);
  if (options.cover) blocks.unshift(options.cover);
  blocksToPdf(blocks, filename, { footer: options.footer });
}

/* ================= Excel 导出（多 Sheet） ================= */

/** 图表截图（base64 不含 data:image/png;base64, 前缀） */
export interface ChartImage {
  title: string;
  base64: string;
  width: number;
  height: number;
}

/** 字符串显示宽度（中日韩字符按 2 计） */
function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

/** 细边框（浅灰色） */
function thinBorder(): Partial<ExcelJS.Borders> {
  return {
    top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
  };
}

/** 数值四舍五入到 2 位小数（非有限值显示 —） */
function r2(v: number | null | undefined): number | string {
  return v != null && Number.isFinite(v) ? Math.round(v * 100) / 100 : '—';
}

/* ---- 条件格式样式（dxf）：浅色底纹 + 加粗字，黑白打印仍可辨识 ----
 * ExcelJS 的 Style 类型要求全部字段，而条件格式（dxf）仅用 fill/font 子集，故用断言 */
const CF_GREEN = {
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' }, bgColor: { argb: 'FFDCFCE7' } },
  font: { color: { argb: 'FF047857' }, bold: true },
} as unknown as ExcelJS.Style;
const CF_RED = {
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' }, bgColor: { argb: 'FFFEE2E2' } },
  font: { color: { argb: 'FFB91C1C' }, bold: true },
} as unknown as ExcelJS.Style;
const CF_GRAY = {
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' }, bgColor: { argb: 'FFF1F5F9' } },
  font: { color: { argb: 'FF64748B' } },
} as unknown as ExcelJS.Style;

/**
 * Baseline 差值表条件格式：Δ 列（C 冠军 / E 中位 / G 平均）数值 >0 绿 / <0 红，
 * 判定列（H）优秀绿 / 不合格红 —— 在直接字体色基础上叠加整格浅色底纹。
 * priority 全表唯一递增，避免 Excel 打开时提示修复。
 */
function addBaselineConditionalFormats(ws: ExcelJS.Worksheet, firstRow: number, lastRow: number): void {
  let priority = 1;
  for (const col of ['C', 'E', 'G'] as const) {
    ws.addConditionalFormatting({
      ref: `${col}${firstRow}:${col}${lastRow}`,
      rules: [
        { type: 'cellIs', operator: 'greaterThan', formulae: ['0'], style: CF_GREEN, priority: priority++ },
        { type: 'cellIs', operator: 'lessThan', formulae: ['0'], style: CF_RED, priority: priority++ },
      ],
    });
  }
  ws.addConditionalFormatting({
    ref: `H${firstRow}:H${lastRow}`,
    rules: [
      { type: 'cellIs', operator: 'equal', formulae: ['"优秀"'], style: CF_GREEN, priority: priority++ },
      { type: 'cellIs', operator: 'equal', formulae: ['"不合格"'], style: CF_RED, priority: priority++ },
    ],
  });
}

/**
 * 构建多 Sheet 报告工作簿（纯数据构建，Node 可测）：
 *   ① 报告信息（含 Baseline 差值对比与分析结论，PCE 与 Voc·FF 双指标）
 *   ② 数据汇总（冠军 / 中位 / 最优）
 *   ③ 分布图（箱线图截图）
 *   ④ 样本明细（全量记录，带筛选）
 *
 * 样式约定：表格单元格上下左右居中、浅灰色细边框；章节标题黑色加粗；
 * 文字部分（字段标签与内容 / 结论 / 注释）水平靠左、垂直居中（仅报告总标题保持居中）；
 * 报告信息字段行与分析结论行同样带浅灰色细边框（合并值区域逐格设置保证外框完整）；
 * 条件格式：Baseline 差值表 Δ 列/判定列红绿浅底纹；样本明细有效测试记录列 是=绿/否=灰；
 * 样本明细冻结表头行 + 首列（批次列），宽表横向滚动时表头与批次号常显；
 * 字体由 applyWorkbookFont 统一替换为微软雅黑；
 * 列宽按各工作表实际内容自适应（写入时跟踪、收尾统一设置）。
 *
 * 注意：列宽一律通过 ws.getColumn(n) 设置（惰性创建）；
 * 空工作表的 ws.columns 为 null，直接 forEach 会抛错（旧版导出失败根因）。
 */
export function buildReportWorkbook(
  meta: ReportMetaInput,
  data: ReportData,
  charts: ChartImage[] = [],
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.reporter || '器件验证数据分析系统';
  wb.created = new Date();

  const allRecords: SampleRecord[] = data.groups.flatMap((g) => g.records);

  /**
   * 工作表构建器：统一表头/数据行样式（居中 + 边框），跟踪各列内容宽度；
   * 合并文本行登记后由 applyWidths 按最终列宽估算换行行数与行高（避免内容被裁剪）。
   */
  const makeSheet = (name: string, colCount: number) => {
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] });
    const widths = new Array<number>(colCount).fill(0);
    const mergedTexts: { row: ExcelJS.Row; from: number; to: number; text: string }[] = [];

    /** 记录各列出现过的最大内容宽度 */
    const track = (values: (string | number)[]) => {
      for (let i = 0; i < Math.min(values.length, colCount); i++) {
        widths[i] = Math.max(widths[i], strWidth(String(values[i] ?? '')));
      }
    };

    /** 登记合并区域文本（applyWidths 时按最终列宽估算行高） */
    const fitMergedHeight = (row: ExcelJS.Row, from: number, to: number, text: string) => {
      mergedTexts.push({ row, from, to, text });
    };

    /** 章节标题行（合并整行、黑色加粗、靠左；仅报告总标题保持居中） */
    const sectionTitle = (text: string) => {
      const row = ws.addRow([text]);
      if (colCount > 1) ws.mergeCells(row.number, 1, row.number, colCount);
      const cell = row.getCell(1);
      cell.font = { bold: true, size: 12, color: { argb: 'FF000000' } };
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
      row.height = 26;
    };

    /** 注释行（合并整行、斜体灰字、靠左换行） */
    const noteRow = (text: string) => {
      const row = ws.addRow([text]);
      if (colCount > 1) ws.mergeCells(row.number, 1, row.number, colCount);
      const cell = row.getCell(1);
      cell.font = { size: 9, italic: true, color: { argb: 'FF94A3B8' } };
      cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      fitMergedHeight(row, 1, colCount, text);
    };

    /** 表头行（居中、底色、边框） */
    const headerRow = (headers: string[]) => {
      track(headers);
      const row = ws.addRow(headers);
      row.height = 22;
      for (let c = 1; c <= headers.length; c++) {
        const cell = row.getCell(c);
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = thinBorder();
        cell.font = { bold: true, size: 10, color: { argb: 'FF475569' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      }
      return row;
    };

    /** 数据行（居中、细边框、统一行高） */
    const dataRow = (
      values: (string | number)[],
      opts: { boldFirst?: boolean; height?: number } = {},
    ) => {
      track(values);
      const row = ws.addRow(values);
      row.height = opts.height ?? 20;
      for (let c = 1; c <= values.length; c++) {
        const cell = row.getCell(c);
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = thinBorder();
        cell.font = { size: 10, color: { argb: 'FF334155' }, bold: opts.boldFirst && c === 1 };
      }
      return row;
    };

    /** 列宽自适应（内容宽度 + 2，下限 8 / 上限 50），并补算合并文本行行高。
     *  ExcelJS 将 width=9 视为默认列宽（isCustomWidth=false），序列化时该列定义
     *  会被整体丢弃（如批次列 CB615W1 宽 7+2=9），恰好 9 时上浮至 9.5 保证显式写入 */
    const applyWidths = () => {
      const applied = widths.map((w) => {
        const v = Math.min(50, Math.max(8, w + 2));
        return v === 9 ? 9.5 : v;
      });
      for (let c = 1; c <= colCount; c++) ws.getColumn(c).width = applied[c - 1];
      for (const m of mergedTexts) {
        const region = Math.max(
          10,
          applied.slice(m.from - 1, m.to).reduce((a, b) => a + b, 0) - 2,
        );
        const lines = m.text
          .split('\n')
          .reduce((n, seg) => n + Math.max(1, Math.ceil(strWidth(seg) / region)), 0);
        m.row.height = Math.min(409, Math.max(20, lines * 15 + 5));
      }
    };

    return {
      ws, colCount, track, fitMergedHeight, sectionTitle, noteRow, headerRow, dataRow, applyWidths,
    };
  };

  /* ---- Sheet 1：报告信息（含 Baseline 差值对比与分析结论，PCE 与 Voc·FF 平均值） ---- */
  {
    const { ws, colCount: COLS, track, fitMergedHeight, sectionTitle, noteRow, headerRow, dataRow, applyWidths } =
      makeSheet('报告信息', 8);

    /* 总标题（合并整行、居中） */
    const titleRow = ws.addRow(['钙钛矿器件验证对比分析报告']);
    ws.mergeCells(titleRow.number, 1, titleRow.number, COLS);
    const titleCell = titleRow.getCell(1);
    titleCell.font = { bold: true, size: 16, color: { argb: 'FF000000' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    titleRow.height = 34;
    ws.addRow([]);

    /* 一、报告信息（标签列计入列宽；值合并跨列居中显示） */
    sectionTitle('一、报告信息');
    const infoRows: [string, string][] = [
      ['汇报人', meta.reporter || '—'],
      ['汇报日期', meta.report_date || '—'],
      ['参与批次', `${data.totals.batches} 个（${data.groups.map((g) => g.batchId).join('、') || '—'}）`],
      ['样品记录', `${data.totals.samples} 条（其中反扫 ${data.totals.reverse} 条）`],
      ['有效测试记录', `${data.totals.valid}/${data.totals.reverse} 条（符合口径反扫数 / 反扫总数；统计基于有效测试记录 = ${criteriaTextShort(data.thresholds)}）`],
      ['研究目的与意义', meta.research_purpose || '—'],
      ['过程与方法', meta.process_method || '—'],
      ['关键工艺参数', meta.key_parameters || '—'],
      ['结果讨论', meta.discussion || '—'],
      ['研究结论', meta.conclusion || '—'],
      ['下一步计划', meta.next_steps || '—'],
    ];
    for (const [label, value] of infoRows) {
      track([label]);
      const row = ws.addRow([label, value]);
      ws.mergeCells(row.number, 2, row.number, COLS);
      const labelCell = row.getCell(1);
      labelCell.font = { bold: true, size: 10, color: { argb: 'FF475569' } };
      labelCell.alignment = { horizontal: 'left', vertical: 'middle' };
      labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      labelCell.border = thinBorder();
      /* 合并区域（值单元格）边框需逐格设置，外框才能完整显示 */
      for (let c = 2; c <= COLS; c++) row.getCell(c).border = thinBorder();
      const valueCell = row.getCell(2);
      valueCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      valueCell.font = { size: 10, color: { argb: 'FF334155' } };
      fitMergedHeight(row, 2, COLS, value); // 行高在 applyWidths 后按最终列宽估算
    }
    ws.addRow([]);

    /* 二、Baseline 差值对比（PCE 与 Voc·FF 平均值，差值 <0 红 / >0 绿） */
    if (data.baseline && data.baseline.diffs.length > 0) {
      const base = data.baseline;
      sectionTitle(`二、Baseline 差值对比（基准：${base.baselineBatchId}）`);
      headerRow([
        '批次', '冠军 PCE (%)', 'Δ 冠军', '中位 PCE (%)', 'Δ 中位',
        '平均 Voc·FF (V)', 'Δ 平均', '判定',
      ]);
      const baseRow = dataRow(
        [
          `⚑ ${base.baselineBatchId}（基准）`,
          fmt(base.baselineChampion),
          '—',
          fmt(base.baselineMedian),
          '—',
          fmt(base.baselineVocffMean),
          '—',
          '基准',
        ],
        { boldFirst: true },
      );
      baseRow.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } };
      });
      let diffFirstRow = 0;
      let diffLastRow = 0;
      for (const d of base.diffs) {
        const row = dataRow([
          d.batchId,
          fmt(d.champion),
          r2(d.championDelta),
          fmt(d.median),
          r2(d.medianDelta),
          fmt(d.vocffMean),
          r2(d.vocffMeanDelta),
          d.verdict,
        ]);
        /* 差值列（Δ 冠军 / Δ 中位 / Δ 平均）：>0 绿、<0 红、=0 中性 */
        for (const c of [3, 5, 7]) {
          const cell = row.getCell(c);
          if (typeof cell.value === 'number' && cell.value !== 0) {
            cell.font = {
              size: 10,
              bold: true,
              color: { argb: cell.value > 0 ? 'FF059669' : 'FFDC2626' },
            };
          }
        }
        row.getCell(8).font = {
          size: 10,
          bold: true,
          color: { argb: d.verdict === '优秀' ? 'FF059669' : 'FFDC2626' },
        };
        if (!diffFirstRow) diffFirstRow = row.number;
        diffLastRow = row.number;
      }
      /* 条件格式：Δ 列与判定列整格红绿浅底纹（叠加在上述字体色之上） */
      if (diffFirstRow && diffLastRow) {
        addBaselineConditionalFormats(ws, diffFirstRow, diffLastRow);
      }
      if (base.conclusion) {
        track(['分析结论']);
        const row = ws.addRow(['分析结论', base.conclusion]);
        ws.mergeCells(row.number, 2, row.number, COLS);
        row.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF475569' } };
        row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
        row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        row.getCell(1).border = thinBorder();
        for (let c = 2; c <= COLS; c++) row.getCell(c).border = thinBorder();
        row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        row.getCell(2).font = { size: 10, color: { argb: 'FF334155' } };
        fitMergedHeight(row, 2, COLS, base.conclusion);
      }
      noteRow(`判定规则：${verdictLabelOf(data.thresholds)} 为优秀，否则不合格；Voc·FF 差值为参考指标，不参与判定。`);
    }
    applyWidths();
  }

  /* ---- Sheet 2：数据汇总（冠军 / 中位 / 最优） ---- */
  {
    const { ws, sectionTitle, noteRow, headerRow, dataRow, applyWidths } = makeSheet('数据汇总', 10);
    sectionTitle('三、数据汇总（冠军 / 中位 / 最优）');
    headerRow([
      '批次', '有效性', '口径', 'PCE (%)', 'Voc (V)', 'Jsc (mA/cm²)',
      'FF', 'Rs (Ω)', 'Rsh (Ω)', 'Voc·FF (V)',
    ]);
    const sumGroups = buildSummaryGroups(data);
    for (const g of sumGroups) {
      if (g.champion) {
        const c = g.champion;
        /* 批次列与有效性列合并同批次 3 行（冠军/中位/最优）：首行写批次号 / 有效 X/Y，
         * 后两行留空，收尾 mergeCells；PDF 模板批次列拆 3 行实现视觉合并（html2canvas 无法垂直居中合并单元格） */
        const firstRow = dataRow(
          [
            batchLabelOf(g.batchId), `有效 ${g.validCount}/${g.totalCount}`, '冠军',
            fmt(c.efficiency), fmt(c.voc_V), fmt(c.jsc_mA_cm2), fmt(c.ff),
            fmt(c.rs_ohm), fmt(c.rsh_ohm), fmt(metricValue(c, 'vocff')),
          ],
          { boldFirst: true },
        );
        dataRow([
          '', '', '中位',
          fmt(g.median.eff), fmt(g.median.voc), fmt(g.median.jsc),
          fmt(g.median.ff), fmt(g.median.rs), fmt(g.median.rsh), fmt(g.median.vocff),
        ]);
        const lastRow = dataRow([
          '', '', '最优',
          fmt(g.best.eff), fmt(g.best.voc), fmt(g.best.jsc),
          fmt(g.best.ff), fmt(g.best.rs), fmt(g.best.rsh), fmt(g.best.vocff),
        ]);
        ws.mergeCells(firstRow.number, 1, lastRow.number, 1);
        ws.mergeCells(firstRow.number, 2, lastRow.number, 2);
      } else {
        dataRow([
          batchLabelOf(g.batchId), `有效 ${g.validCount}/${g.totalCount}`, '—', '无 PCE 测试数据',
          '—', '—', '—', '—', '—', '—',
        ]);
      }
    }
    noteRow(
      `注：统计基于各批次有效测试记录（${criteriaTextShort(data.thresholds)}）；冠军 = 有效测试记录中 PCE 最高（取该次扫描全部参数）；中位 = 各指标中位数；最优 = 各指标独立极值（Rs 取最小）；有效性列 = 有效 X/Y = 符合口径反扫数 / 反扫总数。`,
    );
    applyWidths();
  }

  /* ---- Sheet 3：参数分布图 ---- */
  if (charts.length > 0) {
    const { ws, sectionTitle } = makeSheet('分布图', 8);
    sectionTitle('四、参数分布图（箱线图，含数据点分布）');
    let rowIdx = ws.rowCount + 1;
    for (const chart of charts) {
      const t = ws.getCell(rowIdx, 1);
      t.value = chart.title;
      t.font = { bold: true, size: 11, color: { argb: 'FF000000' } };
      t.alignment = { horizontal: 'left', vertical: 'middle' };
      ws.getRow(rowIdx).height = 22;
      const imageId = wb.addImage({ base64: chart.base64, extension: 'png' });
      ws.addImage(imageId, {
        tl: { col: 0.05, row: rowIdx }, // 0 基行号：锚定在标题行下一行
        ext: { width: chart.width, height: chart.height },
      });
      rowIdx += Math.ceil(chart.height / 20) + 3;
    }
    /* 用空行填充图片占据的区域，保证图片纵向排列不重叠 */
    while (ws.rowCount < rowIdx) ws.addRow([]);
  }

  /* ---- Sheet 4：样本明细（全量记录，带筛选 + 冻结表头） ---- */
  if (allRecords.length > 0) {
    const { ws, sectionTitle, headerRow, dataRow, applyWidths } = makeSheet('样本明细', 12);
    sectionTitle('五、样本明细');
    const detailHeader = [
      '批次', '样品名', '扫描方向', '有效测试记录', 'Voc (V)', 'Jsc (mA/cm²)', 'FF',
      'EFF (%)', 'Rs (Ω)', 'Rsh (Ω)', '测试日期', '操作员',
    ];
    const header = headerRow(detailHeader);
    for (const r of allRecords) {
      dataRow([
        r.batch_id, r.sample_name, r.is_reverse ? '反扫' : '正扫',
        isValidDevice(r, data.thresholds) ? '是' : '否',
        fmt(r.voc_V), fmt(r.jsc_mA_cm2), fmt(r.ff), fmt(r.efficiency),
        fmt(r.rs_ohm), fmt(r.rsh_ohm), r.test_date ?? '', r.operator ?? '',
      ]);
    }
    ws.autoFilter = {
      from: { row: header.number, column: 1 },
      to: { row: ws.rowCount, column: detailHeader.length },
    };
    /* 条件格式：有效测试记录列「是」绿 /「否」灰（浅色底纹，快速识别有效记录） */
    ws.addConditionalFormatting({
      ref: `D${header.number + 1}:D${ws.rowCount}`,
      rules: [
        { type: 'cellIs', operator: 'equal', formulae: ['"是"'], style: CF_GREEN, priority: 1 },
        { type: 'cellIs', operator: 'equal', formulae: ['"否"'], style: CF_GRAY, priority: 2 },
      ],
    });
    /* 冻结章节标题、表头行与首列（批次列），长表滚动时表头与批次号常显 */
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: header.number, showGridLines: false }];
    applyWidths();
  }

  /* 全局字体（微软雅黑），保留粗体/字号/颜色 */
  applyWorkbookFont(wb);
  return wb;
}

export async function exportReportExcel(
  paperEl: HTMLElement,
  meta: ReportMetaInput,
  data: ReportData,
  options: { onProgress?: (msg: string) => void } = {},
): Promise<void> {
  const blob = await exportReportExcelBlob(paperEl, meta, data, options);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildReportFileName(
    meta,
    data.groups.map((g) => g.batchId),
    'xlsx',
  );
  a.click();
  URL.revokeObjectURL(url);
}

/** 导出 Excel 为 Blob（不触发下载，供邮件发送等场景复用） */
export async function exportReportExcelBlob(
  paperEl: HTMLElement,
  meta: ReportMetaInput,
  data: ReportData,
  options: { onProgress?: (msg: string) => void } = {},
): Promise<Blob> {
  options.onProgress?.('正在渲染报告图表…');
  const paper = await capturePaper(paperEl);
  const blocks = extractBlocks(paper, paperEl);

  /* 从截图块提取图表图片（模板仅渲染有有效测试记录的图表，与截图块一一对应） */
  const chartBlocks = blocks.filter((b) => b.kind === 'chart');
  const chartMetrics = data.boxplots.filter((b) => b.data.categories.length > 0);
  const charts: ChartImage[] = [];
  for (let i = 0; i < chartBlocks.length; i++) {
    const metric = chartMetrics[i]?.metric;
    if (!metric) continue;
    const displayWidth = 720;
    const displayHeight = Math.round(
      (chartBlocks[i].canvas.height / chartBlocks[i].canvas.width) * displayWidth,
    );
    charts.push({
      title: `${metric.label}${metric.unit ? `（${metric.unit}）` : ''} 分布对比`,
      base64: chartBlocks[i].canvas.toDataURL('image/png').split(',')[1] ?? '',
      width: displayWidth,
      height: displayHeight,
    });
  }

  options.onProgress?.('正在生成 Excel 文件…');
  const wb = buildReportWorkbook(meta, data, charts);
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* ================= 统一入口 ================= */

export interface ExportOptions {
  onProgress?: (msg: string) => void;
}

/** 导出 PDF：截图 → 封面 + 分块 → A4 分页（行感知 + 续页表头 + 页脚页码）；
 *  文件名自动生成（日期.汇报人-批次号vs…-器件分析报告.pdf） */
export async function exportReportPdf(
  paperEl: HTMLElement,
  meta: ReportMetaInput,
  data: ReportData,
  options: ExportOptions = {},
): Promise<void> {
  const filename = buildReportFileName(
    meta,
    data.groups.map((g) => g.batchId),
    'pdf',
  );
  await exportPdf(paperEl, filename, {
    onProgress: options.onProgress,
    cover: buildCoverBlock(meta, data),
    footer: { date: meta.report_date },
  });
}
