import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { SCHEMA_SQL } from './schema';
import { migrateMaterialBatches } from './migrate';
import { extractParams } from '../parser/ivParser';
import type {
  BatchSummary,
  ImportResult,
  IVCurvePoint,
  ParsedSample,
  ReportMetaInput,
  ReportMetadata,
  SampleFilter,
  SampleRecord,
} from '../types';

/* sql.js 查询结果（exec 返回值的最小结构） */
interface QueryResult {
  columns: string[];
  values: unknown[][];
}

let db: Database | null = null;
let initPromise: Promise<Database> | null = null;

const IDB_NAME = 'device-validation';
const IDB_STORE = 'sqlite';
const IDB_KEY = 'main';

/** 获取数据库单例（首次调用时初始化并尝试恢复 IndexedDB 中的持久化数据） */
export function getDB(): Promise<Database> {
  if (db) return Promise.resolve(db);
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    const saved = await loadFromIDB();
    db = saved ? new SQL.Database(saved) : new SQL.Database();
    db.exec(SCHEMA_SQL);
    // 迁移：旧库补充 discussion 列（已存在时报错可忽略）
    try {
      db.exec('ALTER TABLE report_metadata ADD COLUMN discussion TEXT');
    } catch {
      /* 列已存在 */
    }
    // 迁移：旧结构批次号（材料码-器件号，如 CB615W1-1）自动归并为材料码批次
    const migration = migrateMaterialBatches(db);
    if (migration.mergedBatches > 0) {
      console.log(
        `[批次结构迁移] 已合并 ${migration.mergedBatches} 个旧批次（材料码-器件号 → 材料码），移动 ${migration.movedSamples} 条样本记录`,
      );
      await saveDB();
    }
    return db;
  })();

  return initPromise;
}

/* ---------------- IndexedDB 持久化 ---------------- */

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadFromIDB(): Promise<Uint8Array | null> {
  try {
    const idb = await openIDB();
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // 无持久化数据时使用全新数据库
  }
}

/** 将当前数据库快照持久化到 IndexedDB（每次写操作后调用） */
export async function saveDB(): Promise<void> {
  if (!db) return;
  const idb = await openIDB();
  await new Promise<void>((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(db!.export(), IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- 查询辅助 ---------------- */

function rowsToObjects<T>(results: QueryResult[]): T[] {
  if (!results || results.length === 0) return [];
  const { columns, values } = results[0];
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return obj as T;
  });
}

/* ---------------- 导入 ---------------- */

/**
 * 从源文件名提取测试日期与操作员
 * 约定格式: "0725-0724-晏广元.txt" → 测试日期取第二段（0724），末段为操作员
 */
function parseSourceFileName(fileName: string): { testDate: string; operator: string } {
  const base = fileName.replace(/\.txt$/i, '');
  const parts = base.split('-');
  if (parts.length >= 3 && /^\d{4}$/.test(parts[1])) {
    return { testDate: parts[1], operator: parts.slice(2).join('-') };
  }
  return { testDate: '', operator: '' };
}

/** 批量导入解析后的样本（按 sample_name 去重，重复跳过） */
export async function importSamples(
  samples: ParsedSample[],
  sourceFile: string,
): Promise<ImportResult> {
  const database = await getDB();
  const result: ImportResult = {
    totalBlocks: samples.length,
    imported: 0,
    skipped: 0,
    errors: [],
    batches: [],
  };
  const batches = new Set<string>();
  const { testDate, operator } = parseSourceFileName(sourceFile);

  for (const sample of samples) {
    try {
      // 1. 批次不存在则创建（batch_number 为旧结构遗留列，恒为 NULL；器件号保留在样品名中）
      database.run(
        'INSERT OR IGNORE INTO material_batch (batch_id, material_type, batch_number) VALUES (?, ?, NULL)',
        [sample.batchId, sample.materialType],
      );

      // 2. 样本去重
      const existing = database.exec(
        'SELECT id FROM sample_record WHERE sample_name = ?',
        [sample.sampleName],
      ) as unknown as QueryResult[];
      if (existing.length > 0 && existing[0].values.length > 0) {
        result.skipped++;
        continue;
      }

      // 3. 插入样本参数记录
      const p = extractParams(sample.header);
      database.run(
        `INSERT INTO sample_record (
          batch_id, sample_name, is_reverse, mode, sample_type,
          area_cm2, intensity, isc_mA, voc_V, jsc_mA_cm2, pm_mW,
          im_mA, vm_V, ff, efficiency, rsh_ohm, rs_ohm,
          test_date, operator, source_file
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sample.batchId,
          sample.sampleName,
          sample.isReverse ? 1 : 0,
          sample.header['mode'] ?? 'IV',
          sample.header['sample type'] ?? 'bat',
          p.area,
          p.intensity,
          p.isc,
          p.voc,
          p.jsc,
          p.pm,
          p.im,
          p.vm,
          p.ff,
          p.efficiency,
          p.rsh,
          p.rs,
          testDate,
          operator,
          sourceFile,
        ],
      );

      // 4. 插入 IV 曲线数据点
      const idResult = database.exec('SELECT last_insert_rowid()') as unknown as QueryResult[];
      const recordId = idResult[0].values[0][0] as number;

      const stmt = database.prepare(
        `INSERT INTO iv_curve_data
          (record_id, point_index, voltage_V, current_density_mA_cm2, power_density_mW_cm2)
         VALUES (?, ?, ?, ?, ?)`,
      );
      sample.dataPoints.forEach((pt, i) => {
        stmt.run([recordId, i, pt.voltage_V, pt.current_density_mA_cm2, pt.power_density_mW_cm2]);
      });
      stmt.free();

      result.imported++;
      batches.add(sample.batchId);
    } catch (e) {
      result.errors.push(`${sample.sampleName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await saveDB();
  result.batches = [...batches].sort();
  return result;
}

/* ---------------- 查询 ---------------- */

/** 仪表盘总览统计 */
export function queryDashboardStats(): {
  totalSamples: number;
  totalBatches: number;
  avgEfficiency: number | null;
  maxEfficiency: number | null;
} {
  if (!db) return { totalSamples: 0, totalBatches: 0, avgEfficiency: null, maxEfficiency: null };
  const res = db.exec(`
    SELECT
      (SELECT COUNT(*) FROM sample_record)                                        AS total_samples,
      (SELECT COUNT(*) FROM material_batch)                                       AS total_batches,
      (SELECT AVG(efficiency) FROM sample_record WHERE efficiency IS NOT NULL)     AS avg_efficiency,
      (SELECT MAX(efficiency) FROM sample_record WHERE efficiency IS NOT NULL)     AS max_efficiency
  `) as unknown as QueryResult[];
  const row = rowsToObjects<{
    total_samples: number;
    total_batches: number;
    avg_efficiency: number | null;
    max_efficiency: number | null;
  }>(res)[0];
  return {
    totalSamples: row?.total_samples ?? 0,
    totalBatches: row?.total_batches ?? 0,
    avgEfficiency: row?.avg_efficiency ?? null,
    maxEfficiency: row?.max_efficiency ?? null,
  };
}

/** 批次列表及统计摘要 */
export function queryBatches(): BatchSummary[] {
  if (!db) return [];
  const res = db.exec(`
    SELECT
      b.batch_id,
      b.material_type,
      b.batch_number,
      COUNT(s.id)                                                  AS sample_count,
      SUM(CASE WHEN s.is_reverse = 0 THEN 1 ELSE 0 END)            AS forward_count,
      SUM(CASE WHEN s.is_reverse = 1 THEN 1 ELSE 0 END)            AS reverse_count,
      AVG(s.efficiency)                                            AS avg_efficiency,
      MAX(s.efficiency)                                            AS max_efficiency,
      AVG(s.voc_V)                                                 AS avg_voc,
      AVG(s.jsc_mA_cm2)                                            AS avg_jsc,
      AVG(s.ff)                                                    AS avg_ff,
      MAX(s.test_date)                                             AS last_test_date
    FROM material_batch b
    LEFT JOIN sample_record s ON s.batch_id = b.batch_id
    GROUP BY b.batch_id
    ORDER BY b.batch_id
  `) as unknown as QueryResult[];
  return rowsToObjects<BatchSummary>(res);
}

/** 按条件查询样本记录 */
export function querySamples(filter: SampleFilter = {}): SampleRecord[] {
  if (!db) return [];
  const conditions: string[] = [];
  const params: string[] = [];

  if (filter.batchId) {
    conditions.push('s.batch_id = ?');
    params.push(filter.batchId);
  }
  if (filter.direction === 'forward') conditions.push('s.is_reverse = 0');
  if (filter.direction === 'reverse') conditions.push('s.is_reverse = 1');
  if (filter.search) {
    conditions.push('s.sample_name LIKE ?');
    params.push(`%${filter.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const res = db.exec(
    `SELECT s.* FROM sample_record s ${where} ORDER BY s.batch_id, s.sample_name`,
    params,
  ) as unknown as QueryResult[];
  return rowsToObjects<SampleRecord>(res);
}

/** 查询单条样本的 IV 曲线数据 */
export function queryCurve(recordId: number): IVCurvePoint[] {
  if (!db) return [];
  const res = db.exec(
    `SELECT voltage_V, current_density_mA_cm2, power_density_mW_cm2
     FROM iv_curve_data WHERE record_id = ? ORDER BY point_index`,
    [recordId],
  ) as unknown as QueryResult[];
  return rowsToObjects<IVCurvePoint>(res);
}

/* ---------------- 报告文字模板 ---------------- */

/** 保存报告文字模板（保留最近 20 条） */
export async function saveReportMeta(meta: ReportMetaInput): Promise<void> {
  const database = await getDB();
  database.run(
    `INSERT INTO report_metadata
      (report_date, reporter, research_purpose, process_method, key_parameters, discussion, conclusion, next_steps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.report_date,
      meta.reporter,
      meta.research_purpose,
      meta.process_method,
      meta.key_parameters,
      meta.discussion,
      meta.conclusion,
      meta.next_steps,
    ],
  );
  database.run(
    `DELETE FROM report_metadata
     WHERE id NOT IN (SELECT id FROM report_metadata ORDER BY id DESC LIMIT 20)`,
  );
  await saveDB();
}

/** 查询最近保存的报告文字模板 */
export function queryRecentReportMetas(limit = 10): ReportMetadata[] {
  if (!db) return [];
  const res = db.exec(
    `SELECT id, report_date, reporter, research_purpose, process_method,
            key_parameters, discussion, conclusion, next_steps
     FROM report_metadata ORDER BY id DESC LIMIT ?`,
    [limit],
  ) as unknown as QueryResult[];
  return rowsToObjects<ReportMetadata>(res);
}

/* ---------------- 删除 ---------------- */

/** 删除单条样本（含其曲线数据） */
export async function deleteSample(id: number): Promise<void> {
  const database = await getDB();
  database.run('DELETE FROM iv_curve_data WHERE record_id = ?', [id]);
  database.run('DELETE FROM sample_record WHERE id = ?', [id]);
  await saveDB();
}

/** 删除整个批次（含样本与曲线数据） */
export async function deleteBatch(batchId: string): Promise<void> {
  const database = await getDB();
  database.run(
    `DELETE FROM iv_curve_data
     WHERE record_id IN (SELECT id FROM sample_record WHERE batch_id = ?)`,
    [batchId],
  );
  database.run('DELETE FROM sample_record WHERE batch_id = ?', [batchId]);
  database.run('DELETE FROM material_batch WHERE batch_id = ?', [batchId]);
  await saveDB();
}

/** 清空全部数据（重置数据库） */
export async function resetDB(): Promise<void> {
  await getDB();
  if (!db) return;
  db.exec(`
    DELETE FROM iv_curve_data;
    DELETE FROM sample_record;
    DELETE FROM material_batch;
    DELETE FROM report_metadata;
  `);
  await saveDB();
}
