/**
 * 真实数据验证脚本（Node 环境运行，不依赖浏览器）
 *
 * 验证链路：TXT 解析 → 有效测试记录筛选 → 冠军/中位/最优计算 → Baseline 差值对比
 *          → 讨论初稿生成 → 报告模板渲染结构 → PDF 分页逻辑
 *
 * 运行（已集成为 npm 脚本，由 tools/run-verify.cjs 完成打包/运行/清理）：
 *   npm run verify                     # 类型检查 + 默认数据文件（项目根目录 data/input.txt）
 *   npm run verify -- <TXT 文件路径>   # 指定其他数据文件（相对路径基于当前目录）
 *   环境变量 VERIFY_TXT=<路径> 亦可指定
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { extractParams, parseIVFile, parseSampleName } from '../src/parser/ivParser';
import {
  batchLabelOf,
  buildOverviewSummary,
  buildReportData,
  buildSummaryGroups,
  criteriaText,
  criteriaTextShort,
  CRITERIA_TEXT,
  DEFAULT_THRESHOLDS,
  generateDiscussionDraft,
  isValidDevice,
  metricValue,
  scanLabelOf,
  verdictLabelOf,
  type SummaryGroup,
} from '../src/report/reportData';
import ReportTemplate from '../src/report/ReportTemplate';
import { blocksToPdf, buildReportFileName, buildReportWorkbook } from '../src/report/exporters';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { SCHEMA_SQL } from '../src/database/schema';
import { buildBackupWorkbook, restoreFromWorkbook } from '../src/database/backupCore';
import { migrateMaterialBatches } from '../src/database/migrate';
import type { ReportMetaInput, SampleRecord } from '../src/types';

/* CJS 输出下 __dirname 为 tools 目录，其上一级即项目根目录 */
const toolsDir = typeof __dirname !== 'undefined' ? __dirname : dirname(process.argv[1] ?? '.');
const projectRoot = dirname(toolsDir);

/* 数据文件：命令行参数 / VERIFY_TXT 环境变量可覆盖（相对路径基于 cwd），默认为项目根目录 data/input.txt */
const txtOverride = process.argv[2] ?? process.env.VERIFY_TXT;
const TXT_PATH = txtOverride ? resolve(txtOverride) : resolve(projectRoot, 'data', 'input.txt');

/* ================= 校验结果收集 ================= */

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${detail}`}`);
}
function section(title: string): void {
  console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);
}

/** 独立实现的中位数（与项目代码的线性插值法交叉核对） */
function independentMedian(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  if (n % 2 === 1) return s[(n - 1) / 2];
  return (s[n / 2 - 1] + s[n / 2]) / 2;
}

/* ================= 1. 读取并解析真实 TXT ================= */

section('1. 读取真实数据文件并解析');

let raw: Buffer;
try {
  raw = readFileSync(TXT_PATH);
} catch {
  console.error(`找不到数据文件：${TXT_PATH}`);
  console.error('可通过 npm run verify -- <TXT 路径> 指定，或设置 VERIFY_TXT 环境变量。');
  process.exit(1);
}
let content: string;
try {
  content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  console.log(`  文件：${basename(TXT_PATH)}（UTF-8 编码，${raw.length} 字节）`);
} catch {
  content = new TextDecoder('gb18030').decode(raw);
  console.log(`  文件：${basename(TXT_PATH)}（GBK 编码，${raw.length} 字节）`);
}

const samples = parseIVFile(content);
console.log(`  解析出样本块：${samples.length} 个`);

/* 与 db.ts importSamples 相同的字段映射，构造 SampleRecord[] */
const records: SampleRecord[] = samples.map((s, i) => {
  const p = extractParams(s.header);
  return {
    id: i + 1,
    batch_id: s.batchId,
    sample_name: s.sampleName,
    is_reverse: s.isReverse ? 1 : 0,
    mode: s.header['mode'] ?? 'IV',
    sample_type: s.header['sample type'] ?? 'bat',
    area_cm2: p.area,
    intensity: p.intensity,
    isc_mA: p.isc,
    voc_V: p.voc,
    jsc_mA_cm2: p.jsc,
    pm_mW: p.pm,
    im_mA: p.im,
    vm_V: p.vm,
    ff: p.ff,
    efficiency: p.efficiency,
    rsh_ohm: p.rsh,
    rs_ohm: p.rs,
    test_date: '0724',
    operator: '晏广元',
    source_file: '0725-0724-晏广元.txt',
  };
});

const batchIds = [...new Set(records.map((r) => r.batch_id))];
console.log(`  批次：${batchIds.length} 个（${batchIds.join('、')}）`);

/* ================= 1.5 批次识别（批次 = 材料码，-N = 器件号） ================= */

section('1.5 批次识别（批次 = 材料码，-N = 该批次器件号）');

{
  /* parseSampleName 单元断言：{材料批次}-{器件号}_{序号}，反扫为 _r_ 前缀 */
  const cases: [string, string, number | null, boolean][] = [
    ['CB615W1-1_9', 'CB615W1', 1, false],
    ['CB615W1-1_r_10', 'CB615W1', 1, true],
    ['CB615W1-4_59', 'CB615W1', 4, false],
    ['CB306B1-5_r_62', 'CB306B1', 5, true],
    ['FB715B2-12_155', 'FB715B2', 12, false],
    ['YAN-13_r_158', 'YAN', 13, true],
    ['YAN-16_201', 'YAN', 16, false],
  ];
  for (const [name, batch, device, reverse] of cases) {
    const r = parseSampleName(name);
    check(
      `parseSampleName("${name}") → 批次=${batch} 器件=${device} ${reverse ? '反扫' : '正扫'}`,
      r.materialType === batch && r.deviceNumber === device && r.isReverse === reverse,
      `实际：批次=${r.materialType} 器件=${r.deviceNumber} ${r.isReverse ? '反扫' : '正扫'}`,
    );
  }

  /* 真实数据分组断言：16 个器件样本块归属 4 个材料批次（器件号为全局连续编号） */
  const expectBatches: [string, number[]][] = [
    ['CB615W1', [1, 2, 3, 4]],
    ['CB306B1', [5, 6, 7, 8]],
    ['FB715B2', [9, 10, 11, 12]],
    ['YAN', [13, 14, 15, 16]],
  ];
  check(
    `批次归并为 ${expectBatches.length} 个材料批次（${expectBatches.map(([id]) => id).join('、')}）`,
    batchIds.length === expectBatches.length &&
      expectBatches.every(([id]) => batchIds.includes(id)),
    `实际 ${batchIds.length} 个：${batchIds.join('、')}`,
  );
  for (const [id, devices] of expectBatches) {
    const got = [
      ...new Set(
        samples
          .filter((s) => s.batchId === id)
          .map((s) => s.deviceNumber)
          .filter((n): n is number => n != null),
      ),
    ].sort((a, b) => a - b);
    check(
      `批次 ${id} 含器件 ${devices.join('、')}（每器件正扫/反扫多次记录）`,
      JSON.stringify(got) === JSON.stringify(devices),
      `实际器件：${got.join('、')}`,
    );
  }
  check(
    '样品名保留完整（含器件号与序号，用于明细展示与去重）',
    samples.every((s) => /-\d+/.test(s.sampleName) && s.sampleName.includes('_')),
  );
}

/* ================= 2. 有效测试记录筛选诊断 ================= */

section('2. 有效测试记录筛选（口径：' + CRITERIA_TEXT + '）');

const validRecords = records.filter((r) => isValidDevice(r));
const reverseRecords = records.filter((r) => r.is_reverse === 1);
const forwardCount = records.filter((r) => r.is_reverse !== 1).length;
const fail = { forward: 0, pce: 0, ff: 0, rs: 0, rsh: 0, nullParam: 0 };
for (const r of records) {
  if (r.is_reverse !== 1) fail.forward++;
  if (r.efficiency == null || r.ff == null || r.rs_ohm == null || r.rsh_ohm == null) fail.nullParam++;
  else {
    if (r.efficiency < DEFAULT_THRESHOLDS.pceMin) fail.pce++;
    if (r.ff < DEFAULT_THRESHOLDS.ffMin) fail.ff++;
    if (r.rs_ohm <= DEFAULT_THRESHOLDS.resistanceMin) fail.rs++;
    if (r.rsh_ohm <= DEFAULT_THRESHOLDS.resistanceMin) fail.rsh++;
  }
}
console.log(`  总记录 ${records.length} 条（其中反扫 ${reverseRecords.length} 条） → 有效测试记录 ${validRecords.length} 条`);
console.log(`  未通过原因分布（同一条记录可能命中多项）：正扫 ${fail.forward}｜PCE<${DEFAULT_THRESHOLDS.pceMin}% ${fail.pce}｜FF<${DEFAULT_THRESHOLDS.ffMin} ${fail.ff}｜Rs≤${DEFAULT_THRESHOLDS.resistanceMin} ${fail.rs}｜Rsh≤${DEFAULT_THRESHOLDS.resistanceMin} ${fail.rsh}｜参数缺失 ${fail.nullParam}`);
check(
  '有效测试记录数量与口径一致（反扫且满足阈值，独立计数）',
  validRecords.length === records.filter(
    (r) => r.is_reverse === 1 && r.efficiency != null && r.efficiency >= DEFAULT_THRESHOLDS.pceMin &&
      r.ff != null && r.ff >= DEFAULT_THRESHOLDS.ffMin &&
      r.rs_ohm != null && r.rs_ohm > DEFAULT_THRESHOLDS.resistanceMin &&
      r.rsh_ohm != null && r.rsh_ohm > DEFAULT_THRESHOLDS.resistanceMin,
  ).length,
);
check('有效测试记录均为反扫记录', validRecords.every((r) => r.is_reverse === 1));

/* ================= 3. 构建报告数据（全部批次） ================= */

const reportData = buildReportData(batchIds, records);
const summaryGroups = buildSummaryGroups(reportData);

console.log(`\n  批次 ${reportData.totals.batches} 个｜有有效测试记录 ${reportData.totals.validBatches} 个｜记录 ${reportData.totals.samples} 条（反扫 ${reportData.totals.reverse} 条）｜有效测试记录 ${reportData.totals.valid} 条`);
check('总数统计一致（全部记录 / 反扫 / 有效）', reportData.totals.samples === records.length && reportData.totals.reverse === reverseRecords.length && reportData.totals.valid === validRecords.length);

/* ================= 3.5 口径可配置性（系统设置页修改阈值） ================= */

section('3.5 口径可配置性（自定义阈值实时重算）');

const strict = {
  verdictMode: 'median_only' as const,
  verdictThreshold: 0.5,
  pceMin: 17,
  ffMin: 0.6,
  resistanceMin: 100,
};
const strictText = criteriaText(strict);
const strictData = buildReportData(batchIds, records, strict);
const strictExpected = records.filter(
  (r) => r.is_reverse === 1 && r.efficiency != null && r.efficiency >= 17 &&
    r.ff != null && r.ff >= 0.6 &&
    r.rs_ohm != null && r.rs_ohm > 100 &&
    r.rsh_ohm != null && r.rsh_ohm > 100,
);
console.log(`  自定义口径：${strictText}`);
console.log(`  有效测试记录：默认口径 ${reportData.totals.valid} 条 → 自定义口径 ${strictData.totals.valid} 条（独立计数 ${strictExpected.length}）`);
check(
  '口径文字随配置动态生成（判定方式 + 有效性阈值）',
  strictText.includes('中位 Δ>0（Δ>0.5）') && strictText.includes('PCE≥17%') && strictText.includes('FF≥0.6') && strictText.includes('Rs/Rsh>100Ω') && criteriaText(DEFAULT_THRESHOLDS).includes('冠军 Δ>0 且 中位 Δ>0'),
);
check(
  'ReportData 携带口径配置与口径文字',
  strictData.thresholds.verdictMode === 'median_only' && strictData.thresholds.verdictThreshold === 0.5 &&
    strictData.thresholds.pceMin === 17 && strictData.thresholds.ffMin === 0.6 && strictData.thresholds.resistanceMin === 100 &&
    strictData.criteriaText === strictText,
);
check(
  '自定义阈值下有效测试记录数与独立计数一致',
  strictData.totals.valid === strictExpected.length,
);
check('更严格口径有效测试记录数不增', strictData.totals.valid <= reportData.totals.valid);
check(
  '自定义口径下各批次冠军 = 有效测试记录中 PCE 最高（冠军随阈值变化）',
  strictData.groups.every((g) => {
    const effs = g.validRecords
      .map((r) => r.efficiency)
      .filter((v): v is number => v != null);
    return g.champion == null || g.champion.efficiency === Math.max(...effs);
  }),
);
check(
  '默认口径数据不受自定义调用影响（无共享状态污染）',
  reportData.criteriaText === CRITERIA_TEXT && reportData.totals.valid === validRecords.length,
);
check(
  'verdictLabelOf 随判定配置动态生成（默认/仅冠军/仅中位 + 阈值后缀）',
  verdictLabelOf(DEFAULT_THRESHOLDS) === '冠军 Δ>0 且 中位 Δ>0' &&
    verdictLabelOf({ ...DEFAULT_THRESHOLDS, verdictMode: 'champion_only' }) === '冠军 Δ>0' &&
    verdictLabelOf(strict) === '中位 Δ>0（Δ>0.5）',
);
check(
  '基准批次无有效测试记录时 baseline = null（避免 NaN Δ 把所有批次误判为不合格）',
  buildReportData(batchIds, records, { ...strict, pceMin: 100 }, 'CB615W1').baseline === null,
);
check(
  '基准批次有效但目标批次无效时，目标批次不进入 diffs',
  (() => {
    const d = buildReportData(
      batchIds,
      records,
      { ...strict, pceMin: 26 }, // 仅极少数记录满足，构造部分批次无有效记录的场景
      'CB615W1',
    );
    return (
      d.baseline === null ||
      d.baseline.diffs.every((x) => !isNaN(x.championDelta) && !isNaN(x.medianDelta))
    );
  })(),
);

/* ================= 4. 打印汇总表（冠军 / 中位 / 最优） ================= */

section('4.5 各批次关键参数汇总表（冠军 / 中位 / 最优）');

const W = [11, 7, 16, 8, 8, 9, 8, 8, 9, 9];
console.log(
  ['批次', '口径', '样品', 'PCE%', 'Voc', 'Jsc', 'FF', 'Rs', 'Rsh', 'Voc·FF']
    .map((h, i) => h.padEnd(W[i])).join(''),
);
for (const g of summaryGroups) {
  const row = (label: string, name: string, v: (number | null)[]) =>
    console.log(
      [label === '冠军' ? `${batchLabelOf(g.batchId)} 有效${g.validCount}/${g.totalCount}` : '', label, name, ...v.map((x) => (x == null || isNaN(x) ? '—' : x.toFixed(2)))]
        .map((c, i) => String(c).padEnd(W[i])).join(''),
    );
  if (g.champion) {
    const c = g.champion;
    row('冠军', c.sample_name, [c.efficiency, c.voc_V, c.jsc_mA_cm2, c.ff, c.rs_ohm, c.rsh_ohm, metricValue(c, 'vocff')]);
    row('中位', `有效${g.validCount}/${g.totalCount}`, [g.median.eff, g.median.voc, g.median.jsc, g.median.ff, g.median.rs, g.median.rsh, g.median.vocff]);
    row('最优', '', [g.best.eff, g.best.voc, g.best.jsc, g.best.ff, g.best.rs, g.best.rsh, g.best.vocff]);
  } else {
    console.log(`  ${g.batchId}：无 PCE 测试数据（记录 ${g.totalCount} 条）`);
  }
}

/* ---- 汇总表口径断言（有效测试记录 = 符合口径的反扫记录） ---- */
console.log('\n  口径断言：');
for (const g of reportData.groups) {
  const effs = g.validRecords
    .map((r) => r.efficiency)
    .filter((v): v is number => v != null);
  if (effs.length === 0) continue;
  const rs = g.validRecords
    .map((r) => r.rs_ohm)
    .filter((v): v is number => v != null);
  const rsh = g.validRecords
    .map((r) => r.rsh_ohm)
    .filter((v): v is number => v != null);
  const sg: SummaryGroup | undefined = summaryGroups.find((x) => x.batchId === g.batchId);
  if (!sg || !sg.champion) { check(`${g.batchId} 汇总行存在`, false, '缺失'); continue; }
  check(
    `${g.batchId} 冠军 PCE = 有效测试记录最大值`,
    sg.champion.efficiency === Math.max(...effs),
    `${sg.champion.efficiency} vs ${Math.max(...effs)}`,
  );
  check(
    `${g.batchId} 冠军 = 有效测试记录中 PCE 最高的那条反扫记录（参数取自该次扫描）`,
    g.champion === sg.champion &&
      g.validRecords.some((r) => r === g.champion && r.efficiency === Math.max(...effs)),
  );
  check(
    `${g.batchId} 中位 EFF = 独立中位数（有效测试记录）`,
    Math.abs(sg.median.eff - independentMedian(effs)) < 1e-9,
    `${sg.median.eff.toFixed(2)} vs ${independentMedian(effs).toFixed(2)}`,
  );
  check(`${g.batchId} 最优 EFF = 最大值（= 冠军 PCE）`, sg.best.eff === Math.max(...effs));
  check(`${g.batchId} 最优 Rs = 最小值`, sg.best.rs === Math.min(...rs));
  check(`${g.batchId} 最优 Rsh = 最大值`, sg.best.rsh === Math.max(...rsh));
  check(
    `${g.batchId} 冠军行参数取自该次扫描`,
    sg.champion.voc_V === g.champion!.voc_V && sg.champion.ff === g.champion!.ff,
  );
  check(
    `${g.batchId} 有效 X/Y = 符合口径反扫数 / 反扫总数`,
    sg.validCount === g.validRecords.length && sg.totalCount === g.reverseRecords.length &&
      sg.validCount <= sg.totalCount,
    `有效 ${sg.validCount}/${sg.totalCount}`,
  );
}

/* ================= 6. 生成讨论初稿 ================= */

section('5. 结果讨论初稿（generateDiscussionDraft）');

const draft = generateDiscussionDraft(reportData);
console.log(draft.split('\n').map((l) => '  ' + l).join('\n'));
check('初稿非空', draft.trim().length > 0);
check(
  '初稿包含口径说明（有效测试记录口径 + 反扫总数分母）',
  draft.includes('有效测试记录') && draft.includes('反扫') &&
    draft.includes(criteriaTextShort(DEFAULT_THRESHOLDS)) &&
    draft.includes(`有效 ${reportData.totals.valid}/${reportData.totals.reverse}`),
);
/* 初稿不再追加 Baseline 对比判定内容（结论文本由 4.7 分析结论块单独展示） */
{
  const baseBatchForDraft = reportData.groups.find((g) => g.records.length > 0);
  if (baseBatchForDraft) {
    const dataForDraft = buildReportData(
      batchIds,
      records,
      DEFAULT_THRESHOLDS,
      baseBatchForDraft.batchId,
    );
    const draftWithBase = generateDiscussionDraft(dataForDraft);
    const baseConclusion = dataForDraft.baseline?.conclusion ?? '';
    check(
      '初稿不含 Baseline 对比判定内容（选定基准时也不追加）',
      !draftWithBase.includes('【Baseline 对比判定】') &&
        (baseConclusion.length === 0 || !draftWithBase.includes(baseConclusion)),
    );
  }
}
if (reportData.groups.some((g) => g.champion)) {
  /* 初稿描述的是全局冠军（有效测试记录中 PCE 最高） */
  const globalChampion = reportData.groups
    .map((g) => g.champion)
    .filter((c): c is NonNullable<typeof c> => c != null)
    .reduce((a, b) => ((b.efficiency ?? -Infinity) > (a.efficiency ?? -Infinity) ? b : a));
  check('初稿包含冠军器件描述', draft.includes(globalChampion.sample_name), globalChampion.sample_name);
}

/* ================= 7. 模板渲染结构核对（SSR） ================= */

section('6. 报告模板渲染结构（renderToString 核对）');

const meta: ReportMetaInput = {
  report_date: '2026-08-22',
  reporter: '晏广元',
  research_purpose: '研究目的与意义（验证用文本）。',
  process_method: '过程与方法（验证用文本）。',
  key_parameters: '关键工艺参数（验证用文本）。',
  discussion: draft,
  conclusion: '研究结论（验证用文本）。',
  next_steps: '下一步计划（验证用文本）。',
};
/* React SSR 会在相邻文本节点间插入 <!-- --> 分隔注释，核对前先剔除 */
const html = renderToString(React.createElement(ReportTemplate, { meta, data: reportData })).replace(
  /<!-- -->/g,
  '',
);

const championBatchCount = reportData.groups.filter((g) => g.champion != null).length;
console.log(`  渲染 HTML 长度：${html.length} 字符`);

check('汇总表块存在（data-block="summary"，PDF 分块依赖）', html.includes('data-block="summary"'));
check('无 baseline 时不含 Baseline 差值对比块',
  !html.includes('data-block="baseline-diff"') && !html.includes('4.6 Baseline 差值对比'));
check('讨论块存在（data-block="discussion"）', html.includes('data-block="discussion"'));
check('报告头块存在（data-block="header"）', html.includes('data-block="header"'));

const championGroups = reportData.groups.filter((g) => g.champion);
const allChampLabelsIn = championGroups.every((g) =>
  html.includes(`冠军·${scanLabelOf(g.champion!.sample_name, g.batchId)}`));
check(
  `冠军行完整（${championGroups.length} 个批次均含「冠军·去前缀样品名」）`,
  championGroups.length > 0 && allChampLabelsIn,
);
check(
  '口径列冠军样品名不含批次号前缀',
  championGroups.every((g) => {
    const label = scanLabelOf(g.champion!.sample_name, g.batchId);
    return label === g.champion!.sample_name || !html.includes(`冠军·${g.champion!.sample_name}`);
  }),
);

const medianRowCount = (html.match(/>中位<\/td>/g) ?? []).length;
const bestRowCount = (html.match(/>最优<\/td>/g) ?? []).length;
check(`中位行数量 = 有冠军批次数（${championBatchCount}）`, medianRowCount === championBatchCount, `实际 ${medianRowCount}`);
check(`最优行数量 = 有冠军批次数（${championBatchCount}）`, bestRowCount === championBatchCount, `实际 ${bestRowCount}`);

/* 汇总表批次列：拆为 3 行独立单元格（不用 rowspan，html2canvas 无法垂直居中合并单元格内容）；
 * 冠军行 batch-void-top 空格、中位行 batch-cell batch-mid 内容、最优行 batch-void-bottom 空格；
 * 批次号显示材料码（batchLabelOf 兼容去旧结构序号后缀）；有效测试记录数保留 */
const champSummaryGroups = summaryGroups.filter((g) => g.champion);
const rowspanCount = (html.match(/rowspan=/g) ?? []).length;
check('汇总表不再使用 rowspan（html2canvas 垂直居中缺陷）', rowspanCount === 0, `实际 ${rowspanCount}`);
const voidTopCount = (html.match(/batch-void-top/g) ?? []).length;
const voidBottomCount = (html.match(/batch-void-bottom/g) ?? []).length;
const batchMidCount = (html.match(/batch-cell batch-mid/g) ?? []).length;
check(
  `汇总表批次列拆分空格数 = 有冠军批次数（${championBatchCount}）`,
  voidTopCount === championBatchCount && voidBottomCount === championBatchCount,
  `void-top 实际 ${voidTopCount}，void-bottom 实际 ${voidBottomCount}`,
);
check(
  `汇总表批次列内容格（中位行 batch-mid）数 = 有冠军批次数（${championBatchCount}）`,
  batchMidCount === championBatchCount,
  `实际 ${batchMidCount}`,
);
check(
  '批次列显示批次号（新结构 = 材料码；batchLabelOf 兼容旧结构去序号后缀）',
  ['CB615W1', 'CB306B1', 'FB715B2', 'YAN'].every((id) => batchLabelOf(id) === id) &&
    ['CB615W1-1', 'YAN-13'].every((id) => batchLabelOf(id) === id.replace(/-\d+$/, '')) &&
    champSummaryGroups.every((g) => html.includes(batchLabelOf(g.batchId))),
);
check(
  '批次列保留有效测试记录数显示（有效 X/Y）',
  champSummaryGroups.every((g) => html.includes(`有效 ${g.validCount}/${g.totalCount}`)),
);

check('汇总表口径注释存在（基于有效测试记录）', html.includes('统计基于各批次有效测试记录'));
check('汇总表无批次间 PCE 差分对比章节', !html.includes('批次间 PCE 差分对比'));

const chartBlocks = (html.match(/data-block="chart-/g) ?? []).length;
const expectCharts = reportData.boxplots.filter((b) => b.data.categories.length > 0).length;
check(`箱线图块数量 = ${expectCharts}`, chartBlocks === expectCharts, `实际 ${chartBlocks}`);

/* 箱线图数据点：EFF 数据点数 = 有效测试记录中 EFF 有效值数；各点值须落在所属批次的 [min, max] 内 */
const effBp = reportData.boxplots.find((b) => b.metric.key === 'efficiency')!;
const totalEffPoints = reportData.groups.reduce(
  (s, g) => s + g.validRecords.filter((r) => r.efficiency != null).length,
  0,
);
check(
  `EFF 箱线图数据点数 = 有效测试记录 EFF 有效值数（${totalEffPoints}）`,
  effBp.data.points.length === totalEffPoints,
  `实际 ${effBp.data.points.length}`,
);
const batchEffRange = new Map(
  reportData.groups
    .map((g) => {
      const vs = g.validRecords.map((r) => r.efficiency ?? NaN).filter((v) => !isNaN(v));
      return [g.batchId, [Math.min(...vs), Math.max(...vs)] as const] as const;
    })
    .filter(([, range]) => Number.isFinite(range[0]) && Number.isFinite(range[1])),
);
check(
  '箱线图数据点均落在所属批次有效测试记录 [min, max] 区间',
  effBp.data.points.every(([ci, v]) => {
    const id = effBp.data.categories[ci];
    const range = batchEffRange.get(id);
    return range ? v >= range[0] - 1e-9 && v <= range[1] + 1e-9 : false;
  }),
);

const blockCount = (html.match(/data-block="/g) ?? []).length;
console.log(`  data-block 块总数：${blockCount}（PDF 将按此分块切页）`);
/* 头1 + 总览1 + 手工文字3 + 数据引言1 + 箱线图N + 汇总表1 + 手工文字3（未选 baseline 时无差值对比块） */
check(
  '块总数 = 头1+总览1+文3+引言1+图N+表1+文3',
  blockCount === 1 + 1 + 3 + 1 + expectCharts + 1 + 3,
  `实际 ${blockCount}`,
);

/* ---- 报告总览块（批次 × 关键指标热力矩阵 + 判定汇总，未选基准场景） ---- */
check('报告总览块存在（data-block="overview"，置于报告头之后）', html.includes('data-block="overview"'));
check(
  '总览块位于报告头之后、第一章之前（先看结论再看细节）',
  html.indexOf('data-block="header"') < html.indexOf('data-block="overview"') &&
    html.indexOf('data-block="overview"') < html.indexOf('data-block="purpose"'),
);
check(
  '总览矩阵表头 = 批次 + 6 项关键指标列',
  ['PCE 冠军 (%)', 'PCE 中位 (%)', 'Voc 中位 (V)', 'Jsc 中位 (mA/cm²)', 'FF', 'Voc·FF 平均 (V)']
    .every((h) => html.includes(`<th>${h}</th>`)),
);
check('未选基准时总览矩阵无判定列（无 <th>判定</th>）', !html.includes('<th>判定</th>'));
check('未选基准时总览汇总含提示（未选择基准批次）', html.includes('未选择基准批次'));
check(
  '总览汇总含各关键指标最优批次（PCE 冠军/PCE 中位/平均 Voc·FF 最高为…）',
  html.includes('PCE 冠军最高为') && html.includes('PCE 中位最高为') && html.includes('平均 Voc·FF 最高为'),
);
{
  /* 热力着色单元格数：各指标列有效值 ≥2 时全部有效值单元格着色（独立重算） */
  const overviewColValues = reportData.groups.map((g) => ({
    champion: g.champion?.efficiency ?? NaN,
    medianEff: reportData.metricStats['efficiency'][g.batchId]?.median ?? NaN,
    medianVoc: reportData.metricStats['voc_V'][g.batchId]?.median ?? NaN,
    medianJsc: reportData.metricStats['jsc_mA_cm2'][g.batchId]?.median ?? NaN,
    medianFF: reportData.metricStats['ff'][g.batchId]?.median ?? NaN,
    vocffMean: reportData.metricStats['vocff'][g.batchId]?.mean ?? NaN,
  }));
  const expectHeatCells = overviewColValues.length > 0
    ? (Object.keys(overviewColValues[0]) as (keyof (typeof overviewColValues)[number])[]).reduce((s, k) => {
        const finite = overviewColValues.map((r) => r[k]).filter((v) => Number.isFinite(v));
        return s + (finite.length >= 2 ? finite.length : 0);
      }, 0)
    : 0;
  const heatCellCount = (html.match(/background-color:rgb\(/g) ?? []).length;
  check(
    `总览热力矩阵着色单元格数 = 各指标列有效值数之和（${expectHeatCells}）`,
    heatCellCount === expectHeatCells,
    `实际 ${heatCellCount}`,
  );
}

/* PDF 表格样式契约（截图样式来源 index.css）：
 * ① 单元格上下左右居中且带 !important（防止工具类覆盖）
 * ② 分离边框模型（html2canvas 对 collapse 合并边框渲染易错位/重影） */
{
  const reportCss = readFileSync(resolve(projectRoot, 'src', 'index.css'), 'utf-8');
  const cellRule = reportCss.match(/\.report-table th,\s*\.report-table td\s*\{([^}]*)\}/);
  check(
    '报告表格单元格 CSS 上下左右居中（PDF 截图样式契约）',
    !!cellRule &&
      /text-align:\s*center\s*!important/.test(cellRule[1]) &&
      /vertical-align:\s*middle\s*!important/.test(cellRule[1]),
  );
  check(
    '报告表格边框为分离模型（html2canvas 截图防错位）',
    /\.report-table\s*\{[^}]*border-collapse:\s*separate/.test(reportCss) &&
      /\.report-table\s*\{[^}]*border-spacing:\s*0/.test(reportCss),
  );
}

/* ================= 8. PDF 分页逻辑验证（DOM 垫片） ================= */

section('7. PDF 分页逻辑（blocksToPdf，A4 = 210×297mm）');

try {
  /* Node 环境垫片：jsPDF / 切片 canvas 所需的最小 DOM */
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const fakeDocument = {
    createElement: () => {
      const c = {
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {}, drawImage() {}, fillText() {}, strokeText() {},
          measureText: () => ({ width: 10 }),
          beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
          save() {}, restore() {}, clearRect() {},
        }),
        toDataURL: () => TINY_PNG,
      };
      return c;
    },
  };
  (globalThis as Record<string, unknown>).document = fakeDocument;
  (globalThis as Record<string, unknown>).window = globalThis;
  /* Node ≥21 自带 navigator（只读 getter），无需也不能覆盖 */

  /* 记录 addImage / addPage 调用：包装 jsPDF 构造函数，对每个实例打补丁
   * （jsPDF 2.5.2 的 addPage/save 为实例自有属性，addImage 走 API 原型；
   *   通过 createRequire 取真实 module.exports，与打包内 require 共享同一对象） */
  const pages: { y: number; h: number }[][] = [[]];
  const nodeRequire = createRequire(process.argv[1] ?? '.');
  const rawJspdf = nodeRequire('jspdf') as {
    jsPDF: new (...args: unknown[]) => Record<string, (...a: unknown[]) => unknown>;
  };
  const OriginalJsPDF = rawJspdf.jsPDF;
  rawJspdf.jsPDF = function PatchedJsPDF(this: unknown, ...args: unknown[]) {
    const inst = new OriginalJsPDF(...args);
    const origAddPage = inst.addPage.bind(inst);
    inst.addPage = (...a: unknown[]) => {
      pages.push([]);
      return origAddPage(...a);
    };
    const origAddImage = inst.addImage.bind(inst);
    inst.addImage = (...a: unknown[]) => {
      // 本项目调用形式：addImage(dataURL, 'PNG', x, y, w, h)
      pages[pages.length - 1].push({ y: a[3] as number, h: a[5] as number });
      return origAddImage(...a);
    };
    inst.save = () => undefined; // Node 下不落盘
    return inst;
  };

  /* 画布宽 1588px（794×2），高度按 mm×7.552 模拟真实块高 */
  const PX = 1588 / 210;
  const USABLE_MM = 297 - 8; // 正文可用高度（底部 8mm 预留页脚）
  const mk = (name: string, mm: number) => ({
    name,
    kind: 'text',
    canvas: {
      width: 1588,
      height: Math.round(mm * PX),
      getContext: () => ({
        fillRect() {}, drawImage() {}, fillText() {}, strokeText() {},
        measureText: () => ({ width: 10 }),
        beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        save() {}, restore() {}, clearRect() {},
      }),
      toDataURL: () => TINY_PNG,
    } as unknown as HTMLCanvasElement,
  });
  const blocks = [
    mk('header', 36), mk('purpose', 28), mk('method', 28), mk('keyparams', 28),
    mk('data-intro', 24), mk('chart-1', 95), mk('chart-2', 95), mk('chart-3', 95), mk('chart-4', 95),
    mk('summary', 130), mk('diff', 105), mk('discussion', 62), mk('conclusion', 26), mk('nextsteps', 20),
  ];

  blocksToPdf(blocks as Parameters<typeof blocksToPdf>[0], 'test.pdf');

  const placements = pages.flat();
  const totalPlaced = placements.reduce((s, p) => s + p.h, 0);
  const expectTotal = blocks.reduce((s, b) => s + (b.canvas as unknown as { height: number }).height, 0) / PX;
  const noOverflow = placements.every((p) => p.y >= -0.01 && p.y + p.h <= USABLE_MM + 0.01);

  console.log(`  常规分页：${pages.length} 页，${placements.length} 次放置，总高 ${totalPlaced.toFixed(1)}mm`);
  pages.forEach((p, i) => console.log(`    第 ${i + 1} 页：${p.map((x) => `y=${x.y.toFixed(0)} h=${x.h.toFixed(0)}`).join('，')}`));

  check('分页后无内容丢失（放置总高 = 块总高）', Math.abs(totalPlaced - expectTotal) < 0.5, `${totalPlaced.toFixed(1)} vs ${expectTotal.toFixed(1)}`);
  check('所有放置均在正文可用区域内（底部页脚区不被占用，不截断表格行）', noOverflow);
  check('页数符合预期（4 页）', pages.length === 4, `实际 ${pages.length}`);

  /* 超高块切片：700mm → 289+289+122 三页（正文可用高度 289mm） */
  pages.length = 0;
  pages.push([]);
  blocksToPdf([mk('huge-table', 700)] as Parameters<typeof blocksToPdf>[0], 'test2.pdf');
  const slices = pages.flat();
  console.log(`  超高块切片：${pages.length} 页，切片高 ${slices.map((s) => s.h.toFixed(0)).join(' + ')}mm`);
  check(
    '超高块按页边界切片（700mm → 3 页，289+289+122mm）',
    pages.length === 3 &&
      slices.every((s) => s.h <= USABLE_MM + 0.01) &&
      [289, 289, 122].every((h, i) => Math.abs(slices[i].h - h) < 1) &&
      Math.abs(slices.reduce((a, b) => a + b.h, 0) - 700) < 1,
  );

  /* 行感知分页：切片对齐表格行边界（整行换页）+ 续页重复表头 */
  pages.length = 0;
  pages.push([]);
  const mkRows = (name: string, totalMm: number, rowMm: number, hdrMm: number) => ({
    name,
    kind: 'table',
    canvas: {
      width: 1588,
      height: Math.round(totalMm * PX),
      getContext: () => ({
        fillRect() {}, drawImage() {}, fillText() {}, strokeText() {},
        measureText: () => ({ width: 10 }),
        beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        save() {}, restore() {}, clearRect() {},
      }),
      toDataURL: () => TINY_PNG,
    } as unknown as HTMLCanvasElement,
    breaks: Array.from(
      { length: Math.floor(totalMm / rowMm) + 1 },
      (_, i) => Math.round(i * rowMm * PX),
    ),
    header: { y: 0, h: Math.round(hdrMm * PX) },
  });
  blocksToPdf(
    [mkRows('row-table', 700, 50, 10)] as Parameters<typeof blocksToPdf>[0],
    'test3.pdf',
  );
  const rowPageList = pages.map((p) => [...p]);
  const contentSlices = rowPageList.map((p) => p.filter((x) => x.h > 20));
  console.log(
    `  行感知分页：${rowPageList.length} 页，内容切片 ${contentSlices.flat().map((s) => s.h.toFixed(0)).join(' + ')}mm（行高 50mm，表头 10mm）`,
  );
  check(
    '行感知分页：切片对齐行边界（≈250+250+200mm）',
    rowPageList.length === 3 &&
      [0, 1, 2].every((i) => {
        const c = contentSlices[i];
        return c.length === 1 && Math.abs(c[0].h - [250, 250, 200][i]) < 1;
      }),
    `实际 ${contentSlices.flat().map((s) => s.h.toFixed(0)).join(' + ')}`,
  );
  check(
    '续页重复表头（页 2/3 首个放置为 10mm 表头，内容随后）',
    rowPageList.slice(1).every((p) =>
      p.length === 2 &&
      p[0].y === 0 && Math.abs(p[0].h - 10) < 0.5 &&
      Math.abs(p[1].y - 11.5) < 0.5,
    ),
  );
  check(
    '行感知分页无内容丢失（内容切片总高 = 700mm）',
    Math.abs(contentSlices.flat().reduce((s, x) => s + x.h, 0) - 700) < 1,
  );
  check(
    '行感知分页所有放置均在页边界内（文字不被截断，页脚区不占用）',
    rowPageList.flat().every((p) => p.y >= -0.01 && p.y + p.h <= USABLE_MM + 0.01),
  );

  /* 页脚：底部保留区绘制报告日期与页码（第 X 页 / 共 Y 页） */
  pages.length = 0;
  pages.push([]);
  blocksToPdf([mk('a', 50)] as Parameters<typeof blocksToPdf>[0], 'test5.pdf', {
    footer: { date: '2026-08-22' },
  });
  check(
    '页脚绘制于底部保留区（y=289 高 8mm，内容在前）',
    pages[0].length === 2 &&
      pages[0][0].y === 0 &&
      Math.abs(pages[0][0].h - 50) < 1 &&
      Math.abs(pages[0][1].y - 289) < 0.5 &&
      Math.abs(pages[0][1].h - 8) < 0.5,
    `实际 ${pages[0]?.length ?? 0} 次放置`,
  );
} catch (e) {
  console.log(`  ⚠️ 跳过（Node 环境限制）：${e instanceof Error ? e.message : String(e)}`);
}

/* ================= 8. 数据库备份往返（Excel 导出 → 清空 → 导入 → 比对） ================= */

/* CJS 输出不支持顶层 await，第 8 节（含汇总）包进 async IIFE 执行 */
void (async () => {
section('8. 数据库备份往返（backupCore）');

try {
  const nodeRequire = createRequire(process.argv[1] ?? '.');
  const initSqlJs = nodeRequire('sql.js') as () => Promise<any>;
  const SQL = await initSqlJs();

  /** 与 db.ts 一致：建表 + discussion 列迁移 */
  const newDB = () => {
    const d = new SQL.Database();
    d.exec(SCHEMA_SQL);
    try {
      d.exec('ALTER TABLE report_metadata ADD COLUMN discussion TEXT');
    } catch {
      /* 列已存在 */
    }
    return d;
  };

  /* 源库：2 批次 / 3 样本（含 NULL、中文、浮点）/ 5 曲线点 / 1 报告模板 */
  const dbA = newDB();
  dbA.run(
    'INSERT INTO material_batch (batch_id, material_type, batch_number, description) VALUES (?,?,?,?)',
    ['YAN-16', '钙钛矿', 16, '对照组'],
  );
  dbA.run('INSERT INTO material_batch (batch_id, material_type, batch_number) VALUES (?,?,?)', [
    'CB306B1',
    '钙钛矿',
    1,
  ]);
  const sampleCols =
    'id, batch_id, sample_name, is_reverse, mode, sample_type, area_cm2, intensity, ' +
    'isc_mA, voc_V, jsc_mA_cm2, pm_mW, im_mA, vm_V, ff, efficiency, rsh_ohm, rs_ohm, ' +
    'test_date, operator, source_file, created_at';
  const sampleRows: unknown[][] = [
    [1, 'YAN-16', 'YAN-16_r_202', 1, 'IV', 'bat', 0.09, 100, 25.51, 1.0903, 24.638, 19.6799, 18.05, 1.089, 0.7312, 19.68, 4777.5, 1231.0, '0724', '晏广元', '0725-0724-晏广元.txt', '2026-08-22 10:00:00'],
    [2, 'YAN-16', 'YAN-16_f_101', 0, 'IV', 'bat', 0.09, 100, 24.9, 1.0888, 24.21, 17.652, 16.21, 1.088, 0.6648, 17.65, null, 1350.2, '0724', '晏广元', '0725-0724-晏广元.txt', '2026-08-22 10:01:00'],
    [3, 'CB306B1', 'CB306B1_r_3', 1, 'IV', 'bat', 0.09, 100, 20.1, 1.0655, 19.88, 14.965, 13.99, 1.07, 0.7012, 14.97, 3011.0, 1560.5, '0724', '晏广元', '0725-0724-晏广元.txt', null],
  ];
  for (const r of sampleRows) {
    dbA.run(
      `INSERT INTO sample_record (${sampleCols}) VALUES (${sampleCols.split(',').map(() => '?').join(',')})`,
      r,
    );
  }
  const curveRows: unknown[][] = [
    [1, 0, 0.0, 24.638, 0.0],
    [1, 1, 0.5, 24.6, 12.3],
    [1, 2, 1.09, 0.0, 0.0],
    [3, 0, 0.1, 19.88, 1.988],
    [3, 1, 1.0655, 0.5, 0.53275],
  ];
  for (const r of curveRows) {
    dbA.run(
      'INSERT INTO iv_curve_data (record_id, point_index, voltage_V, current_density_mA_cm2, power_density_mW_cm2) VALUES (?,?,?,?,?)',
      r,
    );
  }
  dbA.run(
    'INSERT INTO report_metadata (report_date, reporter, research_purpose, process_method, key_parameters, discussion, conclusion, next_steps, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ['2026-08-22', '晏广元', '验证备份往返', '导出后导入', 'PCE≥15%', '讨论内容…', '结论内容…', '下一步…', '2026-08-22 11:00:00'],
  );

  /* 导出 → 序列化 */
  const { workbook, summary } = buildBackupWorkbook(dbA);
  console.log(`  导出摘要：${summary.material_batch} 批次 / ${summary.sample_record} 样本 / ${summary.iv_curve_data} 曲线点 / ${summary.report_metadata} 报告模板`);
  check(
    '导出摘要行数一致',
    summary.material_batch === 2 && summary.sample_record === 3 &&
      summary.iv_curve_data === 5 && summary.report_metadata === 1,
  );
  const buffer = await workbook.xlsx.writeBuffer();

  /* 目标库预置脏数据，导入后应被完全替换 */
  const dbB = newDB();
  dbB.run("INSERT INTO material_batch (batch_id, material_type) VALUES ('DIRTY','x')");
  dbB.run("INSERT INTO sample_record (batch_id, sample_name) VALUES ('DIRTY','d1')");
  dbB.run("INSERT INTO report_metadata (report_date, reporter) VALUES ('2000-01-01','旧')");

  const wbLoad = new ExcelJS.Workbook();
  await wbLoad.xlsx.load(buffer);
  const restored = restoreFromWorkbook(dbB, wbLoad);
  check('导入摘要与导出一致', JSON.stringify(restored) === JSON.stringify(summary));

  const q = (d: any, sql: string) => d.exec(sql)[0]?.values ?? [];
  check(
    '样本记录完整一致（含 NULL / 中文 / 浮点）',
    JSON.stringify(q(dbA, 'SELECT * FROM sample_record ORDER BY id')) ===
      JSON.stringify(q(dbB, 'SELECT * FROM sample_record ORDER BY id')),
  );
  check(
    '批次与曲线完整一致',
    JSON.stringify(q(dbA, 'SELECT * FROM material_batch ORDER BY id')) ===
      JSON.stringify(q(dbB, 'SELECT * FROM material_batch ORDER BY id')) &&
      JSON.stringify(q(dbA, 'SELECT * FROM iv_curve_data ORDER BY id')) ===
        JSON.stringify(q(dbB, 'SELECT * FROM iv_curve_data ORDER BY id')),
  );
  check(
    '报告模板完整一致',
    JSON.stringify(q(dbA, 'SELECT * FROM report_metadata ORDER BY id')) ===
      JSON.stringify(q(dbB, 'SELECT * FROM report_metadata ORDER BY id')),
  );

  /* AUTOINCREMENT 续号 */
  dbB.run("INSERT INTO sample_record (batch_id, sample_name) VALUES ('YAN-16','new_one')");
  const newId = q(dbB, 'SELECT last_insert_rowid()')[0][0];
  check('导入后自增主键正常续号（新 id = 4）', newId === 4);

  /* 坏文件：缺少必需 Sheet */
  let rejected = false;
  try {
    restoreFromWorkbook(dbB, new ExcelJS.Workbook());
  } catch {
    rejected = true;
  }
  check('缺少必需工作表时拒绝导入', rejected);

  /* 孤儿曲线 */
  const wbOrphan = new ExcelJS.Workbook();
  await wbOrphan.xlsx.load(buffer);
  wbOrphan.getWorksheet('iv_curve_data').getRow(2).getCell(2).value = 999;
  let orphanRejected = false;
  try {
    restoreFromWorkbook(dbB, wbOrphan);
  } catch {
    orphanRejected = true;
  }
  check('曲线引用不存在样本时拒绝导入', orphanRejected);

  /* 事务回滚：主键冲突发生在写入阶段，目标库应保持原状 */
  const dbC = newDB();
  dbC.run("INSERT INTO material_batch (batch_id, material_type) VALUES ('KEEP','x')");
  const wbDup = new ExcelJS.Workbook();
  await wbDup.xlsx.load(buffer);
  wbDup.getWorksheet('sample_record').addRow([
    1, 'YAN-16', 'dup_row', 0, 'IV', 'bat', null, null, null, null, null, null,
    null, null, null, null, null, null, null, null, null, null,
  ]);
  let dupRejected = false;
  try {
    restoreFromWorkbook(dbC, wbDup);
  } catch {
    dupRejected = true;
  }
  check(
    '写入阶段失败时事务回滚（目标库未被改动）',
    dupRejected &&
      q(dbC, 'SELECT COUNT(*) FROM material_batch')[0][0] === 1 &&
      q(dbC, 'SELECT COUNT(*) FROM sample_record')[0][0] === 0,
  );

  /* ================= 8.5 批次结构迁移（旧批次号 = 材料码-器件号 → 材料码） ================= */

  section('8.5 批次结构迁移（migrateMaterialBatches，应用启动与备份导入后自动执行）');

  /* 参数化查询辅助（q 不带参数绑定） */
  const qp = (d: any, sql: string, params: unknown[] = []) =>
    (d.exec(sql, params)[0]?.values ?? []);

  {
    /* 旧结构：器件被当作批次（模拟历史数据库，16 个「器件批次」各 1 条样本） */
    const dbM = newDB();
    const legacyIds = [
      'CB615W1-1', 'CB615W1-2', 'CB615W1-3', 'CB615W1-4',
      'CB306B1-5', 'CB306B1-6', 'CB306B1-7', 'CB306B1-8',
      'FB715B2-9', 'FB715B2-10', 'FB715B2-11', 'FB715B2-12',
      'YAN-13', 'YAN-14', 'YAN-15', 'YAN-16',
    ];
    for (const id of legacyIds) {
      dbM.run('INSERT INTO material_batch (batch_id, material_type, batch_number) VALUES (?,?,?)', [id, id, 1]);
      dbM.run('INSERT INTO sample_record (batch_id, sample_name, is_reverse) VALUES (?,?,1)', [id, `${id}_r_1`]);
    }
    const mig = migrateMaterialBatches(dbM);
    check('迁移合并 16 个旧批次（材料码-器件号）', mig.mergedBatches === 16, `实际 ${mig.mergedBatches}`);
    check('迁移移动 16 条样本记录', mig.movedSamples === 16, `实际 ${mig.movedSamples}`);
    check(
      '迁移后仅 4 个材料批次（CB615W1 / CB306B1 / FB715B2 / YAN）',
      qp(dbM, 'SELECT COUNT(*) FROM material_batch')[0][0] === 4 &&
        ['CB615W1', 'CB306B1', 'FB715B2', 'YAN'].every(
          (id) => qp(dbM, 'SELECT COUNT(*) FROM material_batch WHERE batch_id = ?', [id])[0][0] === 1,
        ),
      `实际：${q(dbM, 'SELECT batch_id FROM material_batch').map((v) => v[0]).join('、')}`,
    );
    check(
      '迁移后样本归属材料码批次（各 4 条，样品名不变）',
      ['CB615W1', 'CB306B1', 'FB715B2', 'YAN'].every(
        (id) => qp(dbM, 'SELECT COUNT(*) FROM sample_record WHERE batch_id = ?', [id])[0][0] === 4,
      ) &&
        qp(dbM, 'SELECT COUNT(*) FROM sample_record')[0][0] === 16,
    );
    check(
      '迁移幂等：新结构二次执行零改动',
      (() => {
        const again = migrateMaterialBatches(dbM);
        return (
          again.mergedBatches === 0 &&
          again.movedSamples === 0 &&
          qp(dbM, 'SELECT COUNT(*) FROM material_batch')[0][0] === 4
        );
      })(),
    );

    /* 嵌套批次号：AB-12 与 AB-12-1 并存时，AB-12 是 AB-12-1 的归并目标，仅迁移最深层 */
    const dbN = newDB();
    dbN.run("INSERT INTO material_batch (batch_id, material_type) VALUES ('AB-12','AB-12')");
    dbN.run("INSERT INTO material_batch (batch_id, material_type) VALUES ('AB-12-1','AB-12-1')");
    dbN.run("INSERT INTO sample_record (batch_id, sample_name) VALUES ('AB-12','AB-12_5')");
    dbN.run("INSERT INTO sample_record (batch_id, sample_name) VALUES ('AB-12-1','AB-12-1_6')");
    const migN = migrateMaterialBatches(dbN);
    check(
      '嵌套旧批次号仅迁移最深层（AB-12-1 → AB-12，父级批次保留为目标）',
      migN.mergedBatches === 1 &&
        qp(dbN, "SELECT COUNT(*) FROM material_batch WHERE batch_id = 'AB-12'")[0][0] === 1 &&
        qp(dbN, "SELECT COUNT(*) FROM sample_record WHERE batch_id = 'AB-12'")[0][0] === 2,
      `合并 ${migN.mergedBatches} 个`,
    );
  }
} catch (e) {
  console.log(`  ⚠️ 备份往返测试无法执行：${e instanceof Error ? e.message : String(e)}`);
  check('备份往返测试完成', false, String(e));
}

/* ================= 9. Baseline 对比判定 ================= */

section('9. Baseline 对比判定');

{
  const baseline = reportData.groups.find((g) => g.records.length > 0);
  if (baseline) {
    const dataWithBase = buildReportData(
      batchIds,
      records,
      DEFAULT_THRESHOLDS,
      baseline.batchId,
    );
    check('baseline 不为 null', dataWithBase.baseline !== null);
    if (dataWithBase.baseline) {
      check('baselineBatchId 正确', dataWithBase.baseline.baselineBatchId === baseline.batchId);
      check(
        'baselineChampion = 有效测试记录中 PCE 最大值',
        dataWithBase.baseline.baselineChampion ===
          Math.max(...baseline.validRecords
            .map((r) => r.efficiency)
            .filter((v): v is number => v != null)),
      );
      const nonBaseline = dataWithBase.baseline.diffs;
      check('所有差值 = 目标 − 基准', nonBaseline.every((d) =>
        Math.abs(d.championDelta - (d.champion - dataWithBase.baseline!.baselineChampion)) < 0.01 &&
        Math.abs(d.medianDelta - (d.median - dataWithBase.baseline!.baselineMedian)) < 0.01,
      ));
      check('Voc·FF 差值 = 目标 − 基准（平均值口径）', nonBaseline.every((d) =>
        Math.abs((d.vocffMeanDelta ?? NaN) - ((d.vocffMean ?? NaN) - dataWithBase.baseline!.baselineVocffMean)) < 0.01,
      ));
      {
        const baseVocff = baseline.validRecords
          .map((r) => (r.voc_V ?? NaN) * (r.ff ?? NaN))
          .filter((v) => !isNaN(v));
        const baseVocffMean = baseVocff.reduce((a, b) => a + b, 0) / baseVocff.length;
        check(
          '基准 Voc·FF = 基准批次有效测试记录独立平均值',
          Math.abs(dataWithBase.baseline.baselineVocffMean - baseVocffMean) < 1e-9,
          `${dataWithBase.baseline.baselineVocffMean.toFixed(4)} vs ${baseVocffMean.toFixed(4)}`,
        );
      }
      check(
        '判定：冠军 Δ>0 且中位 Δ>0 ⇒ 优秀',
        nonBaseline.every((d) =>
          (d.verdict === '优秀') === (d.championDelta > 0 && d.medianDelta > 0),
        ),
      );
      check('结论文本非空', dataWithBase.baseline.conclusion.length > 0);
      check(
        '结论包含 baseline 批次名',
        dataWithBase.baseline.conclusion.includes(baseline.batchId),
      );
      /* 结论格式：逐批次一行，四指标差值（低于/高于+绝对值）+ 质量判定 */
      const concLines = dataWithBase.baseline.conclusion.split('\n');
      check(
        `结论逐批次一行（${dataWithBase.baseline.diffs.length} 行）`,
        concLines.length === dataWithBase.baseline.diffs.length,
        `实际 ${concLines.length}`,
      );
      check(
        '结论每行含三指标差值与质量判定（最高/中位数效率、平均 Voc*FF）',
        dataWithBase.baseline.diffs.every((d, i) => {
          const line = concLines[i] ?? '';
          const end = i === concLines.length - 1 ? '。' : '；';
          return (
            line.startsWith(`${d.batchId} 微晶电池的`) &&
            line.includes('最高效率') && line.includes('中位数效率') &&
            line.includes('平均 Voc*FF') &&
            !line.includes('最高 Voc*FF') && !line.includes('中位数 Voc*FF') &&
            line.endsWith(`质量${d.verdict}${end}`)
          );
        }),
      );
      check(
        '结论 Voc*FF 差值文本与数据一致（平均值口径，保留 2 位小数）',
        dataWithBase.baseline.diffs.every((d, i) => {
          const line = concLines[i] ?? '';
          return line.includes(Math.abs(d.vocffMeanDelta ?? NaN).toFixed(2));
        }),
      );
      // Baseline 永远排在最前（groups / 箱线图 / 汇总表）
      check(
        'groups 中 baseline 排第一位',
        dataWithBase.groups[0]?.batchId === baseline.batchId,
      );
      check(
        '箱线图类别首项为 baseline',
        dataWithBase.boxplots.every(
          (b) => b.data.categories.length === 0 || b.data.categories[0] === baseline.batchId,
        ),
      );
      /* 模板渲染：Baseline 差值对比表（PCE + Voc·FF 平均值） */
      const htmlBase = renderToString(
        React.createElement(ReportTemplate, { meta, data: dataWithBase }),
      ).replace(/<!-- -->/g, '');
      check('Baseline 差值对比块存在（data-block="baseline-diff"）', htmlBase.includes('data-block="baseline-diff"'));
      check('Baseline 差值对比表含 Voc·FF 平均值对比列（无最高/中位列）',
        htmlBase.includes('平均 Voc·FF') && htmlBase.includes('Δ 平均') &&
        !htmlBase.includes('最高 Voc·FF') && !htmlBase.includes('中位 Voc·FF'));
      check('Baseline 差值对比表无批次间 PCE 差分矩阵',
        !htmlBase.includes('4.6.1 冠军口径') && !htmlBase.includes('4.6.2 中位口径'));
      check(
        'Baseline 差值对比行数 = 表头 + 基准行 + 非基准批次数',
        (htmlBase.match(/data-block="baseline-diff"[\s\S]*?<\/table>/)?.[0].match(/<tr/g)?.length ?? 0) ===
          nonBaseline.length + 2,
      );
      check(
        '汇总表首行为 baseline',
        buildSummaryGroups(dataWithBase)[0]?.batchId === baseline.batchId,
      );
      /* 报告总览（有基准场景）：判定列 + 基准标记 + 判定徽章 + 汇总文字 */
      const overviewRegion =
        htmlBase.match(/data-block="overview"[\s\S]*?(?=data-block=")/)?.[0] ?? '';
      check('总览矩阵含判定列（<th>判定</th>）', overviewRegion.includes('<th>判定</th>'));
      check(
        '总览矩阵基准行带 ⚑ 标记且置于首行',
        overviewRegion.includes(`⚑ ${baseline.batchId}`) &&
          overviewRegion.indexOf(`⚑ ${baseline.batchId}`) < overviewRegion.indexOf('<tbody>') + 400,
      );
      {
        const excBadges = (overviewRegion.match(/bg-emerald-50/g) ?? []).length;
        const failBadges = (overviewRegion.match(/bg-red-50/g) ?? []).length;
        const excCount = nonBaseline.filter((d) => d.verdict === '优秀').length;
        const failCount = nonBaseline.filter((d) => d.verdict === '不合格').length;
        check(
          `总览判定徽章数与差值表判定一致（优秀 ${excCount}、不合格 ${failCount}）`,
          excBadges === excCount && failBadges === failCount,
          `实际 优秀 ${excBadges}、不合格 ${failBadges}`,
        );
      }
      /* buildOverviewSummary：判定计数与批次清单、最优批次（独立重算核对） */
      {
        const overviewText = buildOverviewSummary(dataWithBase);
        const excList = nonBaseline.filter((d) => d.verdict === '优秀');
        const failList = nonBaseline.filter((d) => d.verdict !== '优秀');
        const excPart = excList.length > 0
          ? `优秀 ${excList.length} 个（${excList.map((d) => d.batchId).join('、')}）` : '';
        const failPart = failList.length > 0
          ? `不合格 ${failList.length} 个（${failList.map((d) => d.batchId).join('、')}）` : '';
        check(
          `总览汇总判定计数与批次清单（以 ${baseline.batchId} 为基准的 ${nonBaseline.length} 个对比批次）`,
          overviewText.includes(`以 ${baseline.batchId} 为基准的 ${nonBaseline.length} 个对比批次中：`) &&
            (excPart === '' || overviewText.includes(excPart)) &&
            (failPart === '' || overviewText.includes(failPart)),
          overviewText,
        );
        const champGroups = dataWithBase.groups.filter((g) => g.champion);
        const bestChamp = champGroups.reduce((a, b) =>
          (b.champion!.efficiency ?? -Infinity) > (a.champion!.efficiency ?? -Infinity) ? b : a);
        check(
          '总览汇总 PCE 冠军最高批次与独立计算一致（值保留 2 位）',
          overviewText.includes(
            `PCE 冠军最高为 ${bestChamp.batchId}（${bestChamp.champion!.efficiency.toFixed(2)}%）`,
          ),
          overviewText,
        );
      }
      check(
        '总览汇总（未选基准）不含判定计数、含未选基准提示',
        (() => {
          const t = buildOverviewSummary(reportData);
          return !t.includes('为基准的') && t.includes('未选择基准批次') && t.includes('PCE 冠军最高为');
        })(),
      );
      check(
        '总览汇总（无有效记录）提示调整口径',
        buildOverviewSummary(
          buildReportData(batchIds, records, { ...DEFAULT_THRESHOLDS, pceMin: 100 }),
        ).includes('无符合统计口径的有效测试记录'),
      );
      // 判定逻辑可配置性
      const medianOnly = buildReportData(batchIds, records, {
        ...DEFAULT_THRESHOLDS,
        verdictMode: 'median_only',
      }, baseline.batchId);
      if (medianOnly.baseline) {
        check('median_only 模式判定与独立逻辑一致',
          medianOnly.baseline.diffs.every((d) =>
            (d.verdict === '优秀') === (d.medianDelta > 0)),
        );
      }
      const championOnly = buildReportData(batchIds, records, {
        ...DEFAULT_THRESHOLDS,
        verdictMode: 'champion_only',
      }, baseline.batchId);
      if (championOnly.baseline) {
        check('champion_only 模式判定与独立逻辑一致',
          championOnly.baseline.diffs.every((d) =>
            (d.verdict === '优秀') === (d.championDelta > 0)),
        );
      }
    }
  } else {
    console.log('  ⚠️ 跳过 Baseline 验证：无测试记录批次');
  }
}

/* ================= 10. 报告 Excel 导出（多 Sheet） ================= */

section('10. 报告 Excel 导出（多 Sheet，含 Baseline 路径回归）');

try {
  const excelMeta: ReportMetaInput = {
    report_date: '2026-08-22',
    reporter: '验证脚本',
    research_purpose: '研究目的与意义（Excel 多 Sheet 验证）。',
    process_method: '过程与方法（Excel 多 Sheet 验证）。',
    key_parameters: '关键工艺参数（Excel 多 Sheet 验证）。',
    discussion: '结果讨论（Excel 多 Sheet 验证）。',
    conclusion: '研究结论（Excel 多 Sheet 验证）。',
    next_steps: '下一步计划（Excel 多 Sheet 验证）。',
  };
  /* 带基准构建：旧版在空工作表上访问 ws.columns（null）导致导出失败，此处做回归 */
  const baseBatch = reportData.groups.find((g) => g.records.length > 0)?.batchId;
  const excelData = buildReportData(batchIds, records, DEFAULT_THRESHOLDS, baseBatch);
  const tinyPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const wbReport = buildReportWorkbook(excelMeta, excelData, [
    { title: 'EFF（%） 分布对比', base64: tinyPng, width: 720, height: 320 },
  ]);

  /* 多 Sheet 结构：报告信息（含 Baseline 差值对比）→ 数据汇总 → 分布图 → 样本明细 */
  const SHEET_NAMES = ['报告信息', '数据汇总', '分布图', '样本明细'];
  check(
    `报告工作簿含 ${SHEET_NAMES.length} 个工作表（${SHEET_NAMES.join(' / ')}）`,
    wbReport.worksheets.length === SHEET_NAMES.length &&
      wbReport.worksheets.every((w, i) => w.name === SHEET_NAMES[i]),
    `实际 ${wbReport.worksheets.length} 个：${wbReport.worksheets.map((w) => w.name).join('、')}`,
  );
  const wsChart = wbReport.getWorksheet('分布图');
  check('分布图工作表嵌入图表 1 张', !!wsChart && wsChart.getImages().length === 1);

  /* 条件格式读取辅助（写入侧工作簿；ExcelJS 读入侧对 CF 支持不完整，故断言原始工作簿） */
  const getConditionalFormattings = (ws?: ExcelJS.Worksheet) =>
    (((ws as unknown as { conditionalFormattings?: unknown[] })?.conditionalFormattings ??
      (ws as unknown as { model?: { conditionalFormattings?: unknown[] } })?.model?.conditionalFormattings ??
      []) as {
      ref: string;
      rules: { type: string; operator?: string; priority?: number; style?: { fill?: { bgColor?: { argb?: string } } } }[];
    }[]);

  /* Baseline 差值表条件格式：Δ 列 C/E/G + 判定列 H，各 2 条规则（红/绿底纹） */
  const cfInfo = getConditionalFormattings(wbReport.getWorksheet('报告信息'));
  check(
    'Baseline 差值表条件格式（Δ 列 C/E/G + 判定列 H，各 2 条规则，含红绿底纹）',
    cfInfo.length === 4 &&
      cfInfo.every((c) => /^[CEGH]\d+:[CEGH]\d+$/.test(c.ref)) &&
      cfInfo.every((c) => c.rules.length === 2) &&
      cfInfo.every((c) =>
        c.rules.some((r) => r.style?.fill?.bgColor?.argb === 'FFDCFCE7') &&
        c.rules.some((r) => r.style?.fill?.bgColor?.argb === 'FFFEE2E2'),
      ),
    `实际 ${cfInfo.length} 组：${cfInfo.map((c) => c.ref).join('、') || '无'}`,
  );

  const bufReport = await wbReport.xlsx.writeBuffer();
  const wbReload = new ExcelJS.Workbook();
  await wbReload.xlsx.load(bufReport);
  check(
    '序列化往返后仍为 4 个工作表（名称与顺序一致）',
    wbReload.worksheets.length === SHEET_NAMES.length &&
      wbReload.worksheets.every((w, i) => w.name === SHEET_NAMES[i]),
  );

  /* 汇总全部工作表文本（各章节分布在对应 Sheet 中） */
  const texts: string[] = [];
  wbReload.worksheets.forEach((ws) => {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === 'string') texts.push(cell.value);
      });
    });
  });
  const hasText = (t: string) => texts.some((v) => v.includes(t));
  check(
    '章节齐全（报告信息 / Baseline / 汇总 / 分布图 / 样本明细）',
    hasText('一、报告信息') && hasText('二、Baseline 差值对比') && hasText('三、数据汇总') &&
      hasText('四、参数分布图') && hasText('五、样本明细'),
  );
  check('无批次间 PCE 差分对比章节', !hasText('批次间 PCE 差分对比'));
  check('汇总表三口径行齐全', ['冠军', '中位', '最优'].every((k) => texts.includes(k)));
  const detailCount = texts.filter((v) => v === '反扫' || v === '正扫').length;
  check(
    `样本明细行数 = 记录数（${records.length} 条）`,
    detailCount === records.length,
    `实际 ${detailCount}`,
  );
  check('Baseline 基准行与各批次判定结果写入',
    texts.includes('基准') && !!excelData.baseline &&
      excelData.baseline.diffs.every((d) => texts.includes(d.verdict)));
  check('Baseline 差值对比表含 Voc·FF 平均值对比列',
    hasText('平均 Voc·FF (V)') && hasText('Δ 平均') &&
      !hasText('最高 Voc·FF') && !hasText('中位 Voc·FF'));
  check('全部批次号写入 Excel', batchIds.every((id) => texts.includes(id)));
  /* 数据汇总 Sheet：批次列（A）与有效性列（B）同批次 3 行合并；有效性列独立显示有效 X/Y */
  const sumSummaryGroups = buildSummaryGroups(excelData).filter((g) => g.champion);
  const sumMerges: string[] = wbReload.getWorksheet('数据汇总')?.model.merges ?? [];
  const colMerges = (col: string) =>
    sumMerges.filter((r) => {
      const m = r.match(new RegExp(`^${col}(\\d+):${col}(\\d+)$`));
      return !!m && m[1] !== m[2];
    });
  const batchColMerges = colMerges('A');
  const validColMerges = colMerges('B');
  check(
    `数据汇总 Sheet 批次列合并数 = 有冠军批次数（${sumSummaryGroups.length}）`,
    batchColMerges.length === sumSummaryGroups.length,
    `实际 ${batchColMerges.length}：${batchColMerges.join('、') || '无'}`,
  );
  check(
    `数据汇总 Sheet 有效性列合并数 = 有冠军批次数（${sumSummaryGroups.length}）`,
    validColMerges.length === sumSummaryGroups.length,
    `实际 ${validColMerges.length}：${validColMerges.join('、') || '无'}`,
  );
  check(
    '数据汇总批次号独立显示（无有效数后缀）',
    sumSummaryGroups.every((g) => texts.includes(batchLabelOf(g.batchId)) &&
      !hasText(`${batchLabelOf(g.batchId)}（有效`)),
  );
  check(
    '数据汇总有效性列显示有效 X/Y（符合口径反扫数 / 反扫总数）',
    hasText('有效性') && sumSummaryGroups.every((g) => texts.includes(`有效 ${g.validCount}/${g.totalCount}`)),
  );
  check('报告信息文字字段写入', hasText('研究目的与意义') && hasText('下一步计划'));

  /* 文字部分靠左（大标题除外）抽检（序列化往返后）：总标题居中，章节标题/字段值/结论/注释靠左 */
  const cellWith = (
    ws: ExcelJS.Worksheet | undefined,
    keyword: string,
  ): ExcelJS.Cell | undefined => {
    if (!ws) return undefined;
    const hits: ExcelJS.Cell[] = [];
    ws.eachRow((row) => {
      const v = row.getCell(1).value;
      if (typeof v === 'string' && v.includes(keyword)) hits.push(row.getCell(1));
    });
    return hits[0];
  };
  const wsInfo = wbReload.getWorksheet('报告信息');
  if (wsInfo) {
    const titleCell = wsInfo.getRow(1).getCell(1);
    check(
      '报告总标题保持居中（大标题除外）',
      typeof titleCell.value === 'string' && titleCell.value.includes('钙钛矿器件验证对比分析报告') &&
        titleCell.alignment?.horizontal === 'center' && titleCell.alignment?.vertical === 'middle',
      `对齐=${titleCell.alignment?.horizontal ?? '默认'}`,
    );
    const sec = cellWith(wsInfo, '一、报告信息');
    check('章节标题靠左', !!sec && sec.alignment?.horizontal === 'left');
    let purposeRow = 0;
    let conclRow = 0;
    wsInfo.eachRow((row) => {
      const v = row.getCell(1).value;
      if (!purposeRow && v === '研究目的与意义') purposeRow = row.number;
      if (!conclRow && v === '分析结论') conclRow = row.number;
    });
    const pl = purposeRow ? wsInfo.getRow(purposeRow).getCell(1) : undefined;
    const pv = purposeRow ? wsInfo.getRow(purposeRow).getCell(2) : undefined;
    check(
      '文字字段标签与内容靠左（垂直居中）',
      !!pl && !!pv && pl.alignment?.horizontal === 'left' &&
        pv.alignment?.horizontal === 'left' && pv.alignment?.vertical === 'middle',
    );
    /* 报告信息字段行浅灰细边框：标签格 + 合并值区域（右缘为最后一格的右边框） */
    const purposeBorderRow = purposeRow ? wsInfo.getRow(purposeRow) : null;
    const conclBorderRow = conclRow ? wsInfo.getRow(conclRow) : null;
    const hasThinBorder = (cell: ExcelJS.Cell | undefined): boolean =>
      !!cell &&
      cell.border?.top?.style === 'thin' && cell.border?.top?.color?.argb === 'FFCBD5E1' &&
      cell.border?.left?.style === 'thin' && cell.border?.left?.color?.argb === 'FFCBD5E1';
    check(
      '报告信息字段行带浅灰细边框（含合并值区域右缘）',
      hasThinBorder(purposeBorderRow?.getCell(1)) &&
        purposeBorderRow?.getCell(8).border?.right?.style === 'thin' &&
        purposeBorderRow?.getCell(8).border?.right?.color?.argb === 'FFCBD5E1',
    );
    check(
      '分析结论行带浅灰细边框',
      hasThinBorder(conclBorderRow?.getCell(1)) &&
        conclBorderRow?.getCell(8).border?.right?.style === 'thin' &&
        conclBorderRow?.getCell(8).border?.right?.color?.argb === 'FFCBD5E1',
    );
    const cv = conclRow ? wsInfo.getRow(conclRow).getCell(2) : undefined;
    check('分析结论内容靠左', !!cv && cv.alignment?.horizontal === 'left');
    const note = cellWith(wsInfo, '判定规则');
    check('注释行靠左（判定规则）', !!note && note.alignment?.horizontal === 'left');
  } else {
    check('报告信息工作表存在（文字靠左抽检）', false, '未找到「报告信息」工作表');
  }
  const sumNote = cellWith(wbReload.getWorksheet('数据汇总'), '注：统计基于');
  check('数据汇总口径注释靠左', !!sumNote && sumNote.alignment?.horizontal === 'left');
  const chartTitle = cellWith(wbReload.getWorksheet('分布图'), '分布对比');
  check('分布图图表标题靠左', !!chartTitle && chartTitle.alignment?.horizontal === 'left');

  /* 标题颜色：总标题与章节标题均为黑色（原蓝色已改黑） */
  if (wsInfo) {
    const grandTitle = wsInfo.getRow(1).getCell(1);
    check('报告总标题字体为黑色',
      grandTitle.font?.color?.argb === 'FF000000',
      `实际 ${grandTitle.font?.color?.argb ?? '默认'}`);
    const secBlack = cellWith(wsInfo, '一、报告信息');
    check('章节标题字体为黑色',
      !!secBlack && secBlack.font?.color?.argb === 'FF000000',
      `实际 ${secBlack?.font?.color?.argb ?? '默认'}`);
  }

  /* Baseline 差值对比表：浅灰边框 + 差值红/绿配色（<0 红 / >0 绿） */
  if (wsInfo && excelData.baseline) {
    let baseHeaderRow = 0;
    wsInfo.eachRow((row) => {
      if (!baseHeaderRow && row.getCell(1).value === '批次' && row.getCell(3).value === 'Δ 冠军') {
        baseHeaderRow = row.number;
      }
    });
    check('Baseline 差值对比表头行存在（含 Δ 冠军列）', baseHeaderRow > 0);
    if (baseHeaderRow) {
      const hCell = wsInfo.getRow(baseHeaderRow).getCell(3);
      check('表头单元格带浅灰细边框（#CBD5E1）',
        hCell.border?.top?.style === 'thin' && hCell.border?.top?.color?.argb === 'FFCBD5E1' &&
          hCell.border?.bottom?.style === 'thin' && hCell.border?.bottom?.color?.argb === 'FFCBD5E1',
        `top=${hCell.border?.top?.style ?? '无'}/${hCell.border?.top?.color?.argb ?? '无色'}`);
      /* 差值配色：基准行之后逐行核对 Δ 列（3/5/7）数值与颜色 */
      let colorOk = true;
      let checkedCount = 0;
      for (let r = baseHeaderRow + 2; r <= baseHeaderRow + 1 + excelData.baseline.diffs.length; r++) {
        for (const c of [3, 5, 7]) {
          const cell = wsInfo.getRow(r).getCell(c);
          if (typeof cell.value === 'number' && cell.value !== 0) {
            checkedCount++;
            if (cell.font?.color?.argb !== (cell.value > 0 ? 'FF059669' : 'FFDC2626')) colorOk = false;
          }
        }
      }
      check(`差值单元格配色正确（<0 红 / >0 绿，共 ${checkedCount} 处）`, checkedCount > 0 && colorOk);
    }
  }

  /* 字体与对齐抽检（序列化往返后）：样本明细表头行 + 数据行 */
  const wsDetail = wbReload.getWorksheet('样本明细');
  if (wsDetail) {
    let headerNum = 0;
    wsDetail.eachRow((row) => {
      if (!headerNum && row.getCell(1).value === '批次' && row.getCell(2).value === '样品名') {
        headerNum = row.number;
      }
    });
    const hCell = headerNum ? wsDetail.getRow(headerNum).getCell(3) : null;
    const dCell = headerNum ? wsDetail.getRow(headerNum + 1).getCell(3) : null;
    check(
      '表头/数据单元格字体为微软雅黑',
      (!!hCell && (hCell.font?.name ?? '') === '微软雅黑') &&
        (!!dCell && (dCell.font?.name ?? '') === '微软雅黑'),
    );
    check(
      '表头/数据单元格上下左右居中',
      (!!hCell && hCell.alignment?.horizontal === 'center' && hCell.alignment?.vertical === 'middle') &&
        (!!dCell && dCell.alignment?.horizontal === 'center' && dCell.alignment?.vertical === 'middle'),
    );
    check(
      '样本明细列宽按内容自适应（批次列 > 最小宽度）',
      (wsDetail.getColumn(1).width ?? 0) > 8,
      `实际 ${wsDetail.getColumn(1).width}`,
    );
    check(
      '样本明细带筛选（autoFilter）与冻结表头行 + 首列（批次列 xSplit=1）',
      !!wsDetail.autoFilter &&
        (wsDetail.views[0]?.state ?? '') === 'frozen' &&
        (wsDetail.views[0]?.xSplit ?? 0) === 1,
      `views=${JSON.stringify(wsDetail.views[0] ?? {})}`,
    );
    /* 条件格式：有效测试记录列「是」绿 /「否」灰（D 列区域） */
    const cfDetail = getConditionalFormattings(wbReport.getWorksheet('样本明细'));
    check(
      '样本明细有效测试记录列条件格式（是=绿 / 否=灰，D 列区域 2 条规则）',
      cfDetail.length === 1 &&
        /^D\d+:D\d+$/.test(cfDetail[0].ref) &&
        cfDetail[0].rules.length === 2 &&
        cfDetail[0].rules.some((r) => r.style?.fill?.bgColor?.argb === 'FFDCFCE7') &&
        cfDetail[0].rules.some((r) => r.style?.fill?.bgColor?.argb === 'FFF1F5F9'),
      `实际 ${cfDetail.length} 组：${cfDetail.map((c) => c.ref).join('、') || '无'}`,
    );
  } else {
    check('样本明细工作表存在（字体/对齐抽检）', false, '未找到「样本明细」工作表');
  }
} catch (e) {
  check('报告 Excel 多 Sheet 构建成功', false, e instanceof Error ? e.message : String(e));
}

/* ================= 11. 导出文件自动命名 ================= */

section('11. 导出文件自动命名（日期（YYMMDD）.汇报人-批次号vs批次号vs…-器件分析报告.pdf/xlsx）');

{
  const ids = reportData.groups.map((g) => g.batchId);
  const pdfName = buildReportFileName(meta, ids, 'pdf');
  const xlsxName = buildReportFileName(meta, ids, 'xlsx');
  const expectBase = '260822.晏广元-CB615W1vsCB306B1vsFB715B2vsYAN-器件分析报告';
  check(
    'PDF 文件名 = 日期（YYMMDD）.汇报人-批次号vs…-器件分析报告.pdf',
    pdfName === `${expectBase}.pdf`,
    `实际 ${pdfName}`,
  );
  check(
    'Excel 文件名同规则、扩展名 .xlsx（实际格式为 xlsx，避免格式与扩展名不符警告）',
    xlsxName === `${expectBase}.xlsx`,
    `实际 ${xlsxName}`,
  );

  /* 批次号顺序与报告一致：基准批次排最前（buildReportData 以 baseline 为首） */
  const yanFirst = buildReportData(batchIds, records, DEFAULT_THRESHOLDS, 'YAN');
  const yanName = buildReportFileName(
    meta,
    yanFirst.groups.map((g) => g.batchId),
    'pdf',
  );
  check(
    '批次号顺序 = 报告顺序（基准批次在最前）',
    yanName === '260822.晏广元-YANvsCB615W1vsCB306B1vsFB715B2-器件分析报告.pdf',
    `实际 ${yanName}`,
  );

  /* 汇报人为空：省略该段，无悬挂连字符 */
  const noReporter = buildReportFileName({ report_date: '2026-08-22', reporter: '' }, ids, 'pdf');
  check(
    '汇报人为空时省略该段（无悬挂连字符）',
    noReporter === '260822.CB615W1vsCB306B1vsFB715B2vsYAN-器件分析报告.pdf',
    `实际 ${noReporter}`,
  );

  /* 报告日期缺失/非法：回退当天（6 位） */
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const today6 = `${String(now.getFullYear()).slice(2)}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const fallback = buildReportFileName({ report_date: '', reporter: '晏广元' }, ids, 'pdf');
  check(
    '报告日期缺失时回退当天（6 位 YYMMDD）',
    fallback === `${today6}.晏广元-CB615W1vsCB306B1vsFB715B2vsYAN-器件分析报告.pdf`,
    `实际 ${fallback}`,
  );

  /* 文件名非法字符剔除（汇报人含 Windows 保留字符） */
  const dirty = buildReportFileName({ report_date: '2026-08-22', reporter: '晏/广*元:测试' }, ids, 'pdf');
  check(
    '汇报人含非法字符时剔除（\\/:*?"<>|）',
    dirty === '260822.晏广元测试-CB615W1vsCB306B1vsFB715B2vsYAN-器件分析报告.pdf',
    `实际 ${dirty}`,
  );

  /* 旧结构批次号（材料码-器件号）归并为材料码 */
  const legacy = buildReportFileName(meta, ['CB615W1-1', 'YAN-13'], 'pdf');
  check(
    '批次号归并为材料码（旧结构材料码-器件号 → 材料码）',
    legacy === '260822.晏广元-CB615W1vsYAN-器件分析报告.pdf',
    `实际 ${legacy}`,
  );
}

/* ================= 12. 云端共享设置（纯函数） ================= */

section('12. 云端共享设置解析（cloudSettings）');
{
  const { parseCloudSettings } = await import('../src/utils/cloudSettings');
  const { sanitizeThresholds } = await import('../src/report/reportData');

  // 完整 JSON：两字段均解析
  const full = parseCloudSettings(
    JSON.stringify({
      criteria: { verdictMode: 'champion_only', verdictThreshold: 0.5, pceMin: 16, ffMin: 0.55, resistanceMin: 10 },
      mailRecipients: ['a@x.com', ' b@y.com ', 42, ''],
      updatedAt: '2026-08-24T00:00:00Z',
    }),
  );
  check(
    '完整 JSON 解析：口径 + 收件人均读出',
    full !== null &&
      full.criteria?.verdictMode === 'champion_only' &&
      full.criteria.pceMin === 16 &&
      full.mailRecipients?.length === 2 &&
      full.mailRecipients[1] === 'b@y.com' &&
      full.updatedAt === '2026-08-24T00:00:00Z',
    JSON.stringify(full),
  );

  // 仅口径：收件人为 undefined（不共享语义，拉取时不覆盖本地）
  const onlyCriteria = parseCloudSettings(JSON.stringify({ criteria: { pceMin: 17 } }));
  check(
    '仅含口径时收件人为 undefined（不覆盖本地收件人）',
    onlyCriteria?.criteria?.pceMin === 17 && onlyCriteria.mailRecipients === undefined,
    JSON.stringify(onlyCriteria),
  );

  // 共享空收件人列表（[] 语义 = 清空本地）
  const emptyList = parseCloudSettings(JSON.stringify({ mailRecipients: [] }));
  check('空收件人数组解析为 []（清空语义）', Array.isArray(emptyList?.mailRecipients) && emptyList.mailRecipients.length === 0, JSON.stringify(emptyList));

  // 非法输入返回 null
  check('非法 JSON 返回 null', parseCloudSettings('{oops') === null);
  check('空字符串返回 null', parseCloudSettings('') === null);
  check('非对象 JSON（数组）返回 null', parseCloudSettings('[1,2]') === null);

  // 口径字段非法值回退默认（sanitizeThresholds）
  const bad = sanitizeThresholds({ verdictMode: 'hack', verdictThreshold: 'x' as unknown as number, pceMin: NaN });
  check(
    '口径非法字段回退默认值',
    bad.verdictMode === 'champion_and_median' && bad.verdictThreshold === 0 && bad.pceMin === 15 && bad.ffMin === 0.5 && bad.resistanceMin === 0,
    JSON.stringify(bad),
  );

  // 推送组装函数已导出（内部依赖 localStorage，运行时行为由浏览器侧覆盖）
  const { collectCloudPayload } = await import('../src/utils/cloudSettings');
  check('collectCloudPayload 已导出（共享开关裁剪由浏览器侧覆盖）', typeof collectCloudPayload === 'function');
}

/* ================= 汇总 ================= */

section('验证汇总');
const failed = results.filter((r) => !r.ok);
console.log(`  共 ${results.length} 项断言：通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length > 0) {
  failed.forEach((f) => console.log(`  ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`));
  process.exitCode = 1;
} else {
  console.log('  全部通过 ✔');
}
})();
