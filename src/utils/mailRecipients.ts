/** 默认收件人管理：localStorage 持久化，报告页「发送邮件」时读取 */

/** 持久化键 */
export const MAIL_RECIPIENTS_STORAGE_KEY = 'dv-mail-recipients';

/** 默认收件人（首次使用时预填） */
export const DEFAULT_MAIL_RECIPIENTS: readonly string[] = ['xinxing.han@jingling-tech.com'];

/** 简单邮箱格式校验：local@domain.tld */
export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** 读取收件人列表（非法/缺失时回退默认值） */
export function loadMailRecipients(): string[] {
  try {
    const raw = localStorage.getItem(MAIL_RECIPIENTS_STORAGE_KEY);
    if (!raw) return [...DEFAULT_MAIL_RECIPIENTS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_MAIL_RECIPIENTS];
    const list = parsed
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return list;
  } catch {
    return [...DEFAULT_MAIL_RECIPIENTS];
  }
}

/** 保存收件人列表（去重；localStorage 不可用时静默跳过） */
export function saveMailRecipients(list: string[]): void {
  try {
    localStorage.setItem(MAIL_RECIPIENTS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // localStorage 不可用（隐私模式等）时仅本次会话生效
  }
}
