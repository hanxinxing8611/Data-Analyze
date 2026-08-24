import type { Database } from 'sql.js';

/**
 * 存量批次结构迁移：材料码-器件号 → 材料码批次
 *
 * 旧解析逻辑把「器件」当成了批次（如 CB615W1-1 ~ CB615W1-4 被识别为 4 个批次）；
 * 正确结构为：批次 = 材料码（CB615W1），-N 为该批次第 N 个器件（全局编号）。
 *
 * 迁移规则：batch_id 形如「材料码-器件号」的批次，其样本全部并入「材料码」批次
 * （不存在则创建），随后删除旧批次行。事务包裹保证原子性；幂等——无旧结构
 * 批次时零改动。应用启动与恢复旧备份后均会自动执行。
 */

export interface BatchMigrationResult {
  /** 归并的旧批次数 */
  mergedBatches: number;
  /** 移动的样本记录数 */
  movedSamples: number;
}

/** 旧结构批次号：以「-数字」结尾（如 CB615W1-1、YAN-13） */
function isLegacyBatchId(id: string): boolean {
  return /^.+-\d+$/.test(id);
}

export function migrateMaterialBatches(db: Database): BatchMigrationResult {
  const res = db.exec('SELECT batch_id FROM material_batch') as unknown as {
    values: unknown[][];
  }[];
  const ids = (res[0]?.values ?? []).map((v) => String(v[0]));

  const legacyIds = ids.filter(isLegacyBatchId);
  if (legacyIds.length === 0) return { mergedBatches: 0, movedSamples: 0 };

  /* 若某旧批次号同时是另一旧批次的材料码父级（如 AB-12 与 AB-12-1），
   * 该父级批次是归并目标而非待迁移对象，跳过以保证层次正确 */
  const parentIds = new Set(legacyIds.map((id) => id.replace(/-\d+$/, '')));
  const toMigrate = legacyIds.filter((id) => !parentIds.has(id));

  db.run('BEGIN');
  try {
    let movedSamples = 0;
    for (const legacyId of toMigrate) {
      const parentId = legacyId.replace(/-\d+$/, '');
      db.run(
        'INSERT OR IGNORE INTO material_batch (batch_id, material_type, batch_number) VALUES (?, ?, NULL)',
        [parentId, parentId],
      );
      const cnt = db.exec(
        'SELECT COUNT(*) FROM sample_record WHERE batch_id = ?',
        [legacyId],
      ) as unknown as { values: unknown[][] }[];
      movedSamples += (cnt[0]?.values[0]?.[0] as number) ?? 0;
      db.run('UPDATE sample_record SET batch_id = ? WHERE batch_id = ?', [parentId, legacyId]);
      db.run('DELETE FROM material_batch WHERE batch_id = ?', [legacyId]);
    }
    db.run('COMMIT');
    return { mergedBatches: toMigrate.length, movedSamples };
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}
