/**
 * 数据库备份核心逻辑（纯函数，操作传入的 sql.js Database 实例）
 *
 * 导出：四张表 → Excel 工作簿（每表一个 Sheet，sheet 名 = 表名，首行为列名）
 * 导入：校验工作簿结构 → 事务内清空并回填（保留原 id，保证曲线数据的引用一致）
 *
 * 与 db.ts 解耦（不 import db.ts），便于 Node 验证脚本直接测试往返一致性。
 */
import ExcelJS from 'exceljs';
import type { Database } from 'sql.js';
import { applyWorkbookFont } from '../utils/font';

/** 参与备份的表（Sheet 名与表名一致，保证导入往返匹配） */
export const BACKUP_TABLES = [
  'material_batch',
  'sample_record',
  'iv_curve_data',
  'report_metadata',
] as const;

/** 各表导入时必须存在的列（对应建表的 NOT NULL 约束） */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  material_batch: ['batch_id', 'material_type'],
  sample_record: ['batch_id', 'sample_name'],
  iv_curve_data: ['record_id'],
  report_metadata: ['report_date', 'reporter'],
};

/** sql.js 查询结果最小结构 */
interface QueryResult {
  columns: string[];
  values: unknown[][];
}

/** 各表行数摘要 */
export interface BackupSummary {
  material_batch: number;
  sample_record: number;
  iv_curve_data: number;
  report_metadata: number;
}

/** 读取表结构：列名与声明类型（PRAGMA table_info） */
function getTableColumns(
  database: Database,
  table: string,
): { name: string; type: string }[] {
  const res = database.exec(`PRAGMA table_info(${table})`) as unknown as QueryResult[];
  if (!res.length) return [];
  // 列：cid, name, type, notnull, dflt_value, pk
  return res[0].values.map((v) => ({ name: String(v[1]), type: String(v[2] || 'TEXT') }));
}

/* ================= 导出 ================= */

/** 将数据库四张表导出为 Excel 工作簿（含表头样式与筛选器） */
export function buildBackupWorkbook(database: Database): {
  workbook: ExcelJS.Workbook;
  summary: BackupSummary;
} {
  const workbook = new ExcelJS.Workbook();
  const summary = {
    material_batch: 0,
    sample_record: 0,
    iv_curve_data: 0,
    report_metadata: 0,
  };

  for (const table of BACKUP_TABLES) {
    const cols = getTableColumns(database, table).map((c) => c.name);
    const ws = workbook.addWorksheet(table, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(cols);

    const res = database.exec(`SELECT * FROM ${table}`) as unknown as QueryResult[];
    const rows = res.length > 0 ? res[0].values : [];
    for (const r of rows) ws.addRow(r.map((v) => (v == null ? null : v)));
    summary[table] = rows.length;

    // 表头样式 + 筛选器 + 列宽（按内容长度粗略自适应）
    const header = ws.getRow(1);
    header.font = { bold: true, size: 11 };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: cols.length },
    };
    const widths = cols.map((c) => c.length);
    for (const r of rows) {
      r.forEach((v, i) => {
        const len = v == null ? 0 : String(v).length;
        if (len > (widths[i] ?? 0)) widths[i] = len;
      });
    }
    widths.forEach((w, i) => {
      ws.getColumn(i + 1).width = Math.min(Math.max(w + 2, 10), 42);
    });
  }

  // 全部单元格统一字体（方正雅黑）
  applyWorkbookFont(workbook);

  return { workbook, summary };
}

/* ================= 导入 ================= */

/** Excel 单元格值 → string | number | null（null 表示空） */
function cellToRaw(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ` +
      `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`
    );
  }
  if (typeof v === 'object') {
    // 公式取计算结果；富文本拼接；超链接取显示文本
    const obj = v as unknown as Record<string, unknown>;
    if ('result' in obj) return cellToRaw(obj.result as ExcelJS.CellValue);
    if ('richText' in obj && Array.isArray(obj.richText)) {
      const text = (obj.richText as { text: string }[]).map((t) => t.text).join('');
      return text.trim() === '' ? null : text;
    }
    if ('text' in obj) {
      const text = String(obj.text);
      return text.trim() === '' ? null : text;
    }
    if ('error' in obj) throw new Error(`单元格包含错误值：${String(obj.error)}`);
  }
  return String(v);
}

/** 按列声明类型转换为 SQL 绑定值（INTEGER/REAL/TEXT） */
function toSqlValue(raw: string | number | null, type: string, ctx: string): string | number | null {
  if (raw === null) return null;
  const upper = type.toUpperCase();
  if (upper === 'INTEGER' || upper === 'REAL') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isNaN(n)) throw new Error(`${ctx}：数值列出现非数值「${String(raw)}」`);
    return upper === 'INTEGER' ? Math.round(n) : n;
  }
  return String(raw);
}

/** 读取 Sheet：表头列名 + 数据行（跳过全空行） */
function sheetToRows(ws: ExcelJS.Worksheet): { headers: string[]; rows: ExcelJS.CellValue[][] } {
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const name = cell.value == null ? '' : String(cellToRaw(cell.value) ?? '');
    headers[colNumber - 1] = name;
  });
  for (let i = 0; i < headers.length; i++) headers[i] = headers[i] ?? '';

  const rows: ExcelJS.CellValue[][] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const vals = headers.map((_, i) => row.getCell(i + 1).value);
    const nonEmpty = vals.some((v) => v !== null && v !== undefined && v !== '');
    if (nonEmpty) rows.push(vals);
  }
  return { headers, rows };
}

/** 解析一张表：按表头映射到真实列（未知列忽略），并做类型转换 */
function parseTable(
  ws: ExcelJS.Worksheet | undefined,
  database: Database,
  table: string,
): { columns: string[]; rows: (string | number | null)[][] } {
  if (!ws) return { columns: [], rows: [] };
  const tableCols = getTableColumns(database, table);
  const known = new Set(tableCols.map((c) => c.name));
  const typeOf = new Map(tableCols.map((c) => [c.name, c.type]));

  const { headers, rows } = sheetToRows(ws);
  const columnMap: (string | null)[] = headers.map((h) => (h && known.has(h) ? h : null));
  const columns = columnMap.filter((c): c is string => c !== null);

  const missing = REQUIRED_COLUMNS[table].filter(
    (c) => !columns.includes(c),
  );
  if (missing.length > 0) {
    throw new Error(`Sheet「${table}」缺少必需列：${missing.join('、')}`);
  }

  const converted = rows.map((vals, i) => {
    const out: (string | number | null)[] = [];
    columnMap.forEach((col, idx) => {
      if (col === null) return;
      const raw = cellToRaw(vals[idx]);
      out.push(toSqlValue(raw, typeOf.get(col) ?? 'TEXT', `Sheet「${table}」第 ${i + 2} 行`));
    });
    return out;
  });
  return { columns, rows: converted };
}

/** 取行中某列的值（用于唯一性/外键校验） */
function colIndex(columns: string[], name: string): number {
  return columns.indexOf(name);
}

/**
 * 从备份工作簿恢复数据库：结构校验 → 事务内清空四表并回填。
 * 校验失败或写入出错时抛出异常且不改动数据（事务回滚）。
 */
export function restoreFromWorkbook(
  database: Database,
  workbook: ExcelJS.Workbook,
): BackupSummary {
  // 1. 必需 Sheet 检查
  const wsBatch = workbook.getWorksheet('material_batch');
  const wsSample = workbook.getWorksheet('sample_record');
  if (!wsBatch || !wsSample) {
    throw new Error('不是有效的备份文件：缺少 material_batch / sample_record 工作表');
  }

  // 2. 逐表解析（含列校验与类型转换）
  const parsed = {
    material_batch: parseTable(wsBatch, database, 'material_batch'),
    sample_record: parseTable(wsSample, database, 'sample_record'),
    iv_curve_data: parseTable(
      workbook.getWorksheet('iv_curve_data'),
      database,
      'iv_curve_data',
    ),
    report_metadata: parseTable(
      workbook.getWorksheet('report_metadata'),
      database,
      'report_metadata',
    ),
  };

  // 3. 数据完整性校验
  const batchCols = parsed.material_batch.columns;
  const bi = colIndex(batchCols, 'batch_id');
  const batchIds = new Set<string>();
  parsed.material_batch.rows.forEach((r, i) => {
    const id = r[bi];
    if (id === null) throw new Error(`material_batch 第 ${i + 2} 行：batch_id 为空`);
    if (batchIds.has(String(id))) {
      throw new Error(`material_batch 第 ${i + 2} 行：batch_id「${id}」重复`);
    }
    batchIds.add(String(id));
  });

  const sampleCols = parsed.sample_record.columns;
  const siBatch = colIndex(sampleCols, 'batch_id');
  const siName = colIndex(sampleCols, 'sample_name');
  const sampleNames = new Set<string>();
  let orphanBatches = 0;
  parsed.sample_record.rows.forEach((r, i) => {
    const name = r[siName];
    if (name === null) throw new Error(`sample_record 第 ${i + 2} 行：sample_name 为空`);
    if (sampleNames.has(String(name))) {
      throw new Error(`sample_record 第 ${i + 2} 行：sample_name「${name}」重复`);
    }
    sampleNames.add(String(name));
    const bid = r[siBatch];
    if (bid === null) throw new Error(`sample_record 第 ${i + 2} 行：batch_id 为空`);
    if (!batchIds.has(String(bid))) orphanBatches++;
  });
  if (orphanBatches > 0) {
    throw new Error(`sample_record 中有 ${orphanBatches} 条记录引用了不存在的批次`);
  }

  const sampleIds = new Set<string>();
  if (colIndex(sampleCols, 'id') >= 0) {
    const siId = colIndex(sampleCols, 'id');
    parsed.sample_record.rows.forEach((r) => {
      const id = r[siId];
      if (id !== null) sampleIds.add(String(id));
    });
  }
  const curveCols = parsed.iv_curve_data.columns;
  const curveRows = parsed.iv_curve_data.rows;
  let orphanCurves = 0;
  if (curveRows.length > 0) {
    if (sampleIds.size === 0) {
      throw new Error('iv_curve_data 有数据但 sample_record 缺少 id 列，无法对应曲线归属');
    }
    const ciRec = colIndex(curveCols, 'record_id');
    curveRows.forEach((r, i) => {
      const rid = r[ciRec];
      if (rid === null) throw new Error(`iv_curve_data 第 ${i + 2} 行：record_id 为空`);
      if (!sampleIds.has(String(rid))) orphanCurves++;
    });
  }
  if (orphanCurves > 0) {
    throw new Error(`iv_curve_data 中有 ${orphanCurves} 条曲线引用了不存在的样本记录`);
  }

  const metaCols = parsed.report_metadata.columns;
  const miDate = colIndex(metaCols, 'report_date');
  const miReporter = colIndex(metaCols, 'reporter');
  parsed.report_metadata.rows.forEach((r, i) => {
    if (r[miDate] === null) {
      throw new Error(`report_metadata 第 ${i + 2} 行：report_date 为空`);
    }
    if (r[miReporter] === null) {
      throw new Error(`report_metadata 第 ${i + 2} 行：reporter 为空`);
    }
  });

  // 4. 事务内替换全部数据（保留原 id，AUTOINCREMENT 序列随之更新）
  database.exec('BEGIN');
  try {
    for (const table of BACKUP_TABLES) database.run(`DELETE FROM ${table}`);
    for (const table of BACKUP_TABLES) {
      const { columns, rows } = parsed[table];
      if (columns.length === 0) continue;
      const stmt = database.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns
          .map(() => '?')
          .join(', ')})`,
      );
      try {
        for (const r of rows) stmt.run(r);
      } finally {
        stmt.free();
      }
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }

  return {
    material_batch: parsed.material_batch.rows.length,
    sample_record: parsed.sample_record.rows.length,
    iv_curve_data: parsed.iv_curve_data.rows.length,
    report_metadata: parsed.report_metadata.rows.length,
  };
}
