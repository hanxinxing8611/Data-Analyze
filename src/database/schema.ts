/**
 * 数据库表结构
 *
 * material_batch      材料批次（1 个批次 = 同一材料同一工艺条件下制备的一组样品）
 * sample_record       样品测试记录（每条对应 TXT 中一个样本块的关键参数）
 * iv_curve_data        IV 曲线数据点（每条测试记录约 40 个电压/电流/功率点）
 *  report_metadata     报告元数据（研究目的、过程方法、结论等手工录入内容）
 *  schedule            排产计划（工程师、批次、材料、验证与报告时间节点）
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS material_batch (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id      TEXT NOT NULL UNIQUE,
    material_type TEXT NOT NULL,
    batch_number  INTEGER,
    description   TEXT,
    created_at    TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sample_record (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id        TEXT NOT NULL,
    sample_name     TEXT NOT NULL UNIQUE,
    is_reverse      INTEGER DEFAULT 0,
    mode            TEXT,
    sample_type     TEXT,
    area_cm2        REAL,
    intensity       REAL,
    isc_mA          REAL,
    voc_V           REAL,
    jsc_mA_cm2      REAL,
    pm_mW           REAL,
    im_mA           REAL,
    vm_V            REAL,
    ff              REAL,
    efficiency      REAL,
    rsh_ohm         REAL,
    rs_ohm          REAL,
    test_date       TEXT,
    operator        TEXT,
    source_file     TEXT,
    created_at      TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (batch_id) REFERENCES material_batch(batch_id)
);

CREATE TABLE IF NOT EXISTS iv_curve_data (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id               INTEGER NOT NULL,
    point_index             INTEGER,
    voltage_V               REAL,
    current_density_mA_cm2  REAL,
    power_density_mW_cm2    REAL,
    FOREIGN KEY (record_id) REFERENCES sample_record(id)
);

CREATE TABLE IF NOT EXISTS report_metadata (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date      TEXT NOT NULL,
    reporter         TEXT NOT NULL,
    research_purpose TEXT,
    process_method   TEXT,
    key_parameters   TEXT,
    conclusion       TEXT,
    next_steps       TEXT,
    created_at       TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sample_batch ON sample_record(batch_id);
CREATE INDEX IF NOT EXISTS idx_curve_record ON iv_curve_data(record_id);

CREATE TABLE IF NOT EXISTS schedule (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id        TEXT NOT NULL,
    material_type   TEXT NOT NULL,
    engineer_name   TEXT NOT NULL,
    engineer_email  TEXT NOT NULL,
    start_date      TEXT NOT NULL,
    report_deadline TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'planned',
    notes           TEXT,
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
`;
