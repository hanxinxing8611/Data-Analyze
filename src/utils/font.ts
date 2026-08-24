/**
 * 全局字体定义（微软雅黑优先，未安装时回退系统黑体）
 *
 * - CSS / ECharts 使用 FONT_STACK（多候选 + 系统回退）
 * - Excel 单元格字体只能写单一名称，使用 EXCEL_FONT
 */
import type { Workbook } from 'exceljs';

/** CSS / 图表字体栈 */
export const FONT_STACK =
  '"Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", Arial, sans-serif';

/** Excel 单元格字体名 */
export const EXCEL_FONT = '微软雅黑';

/** 将工作簿全部已用单元格字体替换为微软雅黑（保留粗体 / 字号 / 颜色） */
export function applyWorkbookFont(workbook: Workbook, name = EXCEL_FONT): void {
  workbook.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        cell.font = { ...cell.font, name };
      });
    });
  });
}
