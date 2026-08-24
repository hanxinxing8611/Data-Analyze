/**
 * 数据库备份的应用层入口（浏览器端）
 *
 * - exportDatabaseBackup：导出四张表为 .xlsx 工作簿并触发下载
 * - importDatabaseBackup：读取 .xlsx 备份，替换当前全部数据并持久化
 * - importSharedSnapshot：拉取部署站点的共享数据快照（public/shared/data-latest.xlsx）
 */
import ExcelJS from 'exceljs';
import { getDB, saveDB } from './db';
import { buildBackupWorkbook, restoreFromWorkbook, type BackupSummary } from './backupCore';
import { migrateMaterialBatches } from './migrate';

function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 导出数据库备份（.xlsx），返回各表行数摘要 */
export async function exportDatabaseBackup(): Promise<BackupSummary> {
  const database = await getDB();
  const { workbook, summary } = buildBackupWorkbook(database);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `器件验证数据备份_${fileStamp()}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  return summary;
}

/** 导入备份文件（.xlsx）替换当前全部数据，返回各表行数摘要 */
export async function importDatabaseBackup(file: File): Promise<BackupSummary> {
  const database = await getDB();
  let workbook: ExcelJS.Workbook;
  try {
    const buf = await file.arrayBuffer();
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf);
  } catch {
    throw new Error(
      '无法解析该文件：请确认选择的是本系统导出的 .xlsx 备份（旧版 .xls 请先用 Excel 另存为 .xlsx）',
    );
  }
  const summary = restoreFromWorkbook(database, workbook);
  // 旧结构备份（批次号 = 材料码-器件号）恢复后自动归并为材料码批次（幂等，新结构备份零改动）
  const migration = migrateMaterialBatches(database);
  if (migration.mergedBatches > 0) {
    console.log(
      `[批次结构迁移] 备份导入后合并 ${migration.mergedBatches} 个旧批次，移动 ${migration.movedSamples} 条样本记录`,
    );
  }
  await saveDB();
  return summary;
}

/**
 * 拉取共享数据快照并替换当前全部数据：
 * 快照由维护者发布于仓库 public/shared/data-latest.xlsx（随站点一起部署），
 * 任意工程师打开站点即可一键拉取权威数据集。
 */
export async function importSharedSnapshot(): Promise<BackupSummary> {
  // BASE_URL：生产为 /Data-Analyze/，开发为 /；查询参数避免 Pages 短缓存拿到旧快照
  const url = `${import.meta.env.BASE_URL}shared/data-latest.xlsx?t=${Date.now()}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('无法访问共享数据（网络异常），请检查网络后重试');
  }
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? '共享数据尚未发布：请维护者将最新备份 xlsx 放入 public/shared/data-latest.xlsx 并推送'
        : `共享数据拉取失败（HTTP ${res.status}），请稍后重试`,
    );
  }
  const blob = await res.blob();
  const file = new File([blob], 'data-latest.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  return importDatabaseBackup(file);
}
