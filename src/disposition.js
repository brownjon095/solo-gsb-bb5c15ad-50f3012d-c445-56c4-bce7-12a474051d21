'use strict';

/**
 * 冲突处置工作台（Conflict Disposition Workbench）
 *
 * 对已保存分析中的每条冲突追加人工处置状态（待处理 / 已确认 / 已解决）与批注。
 * 设计原则：
 * - **以稳定的区域对（zone pair）为键**：冲突编号 conflict-N 会随重新分析漂移，
 *   区域对键（与「分析对比」一致的排序拼接键）才是跨次打开的稳定标识；
 * - **处置数据与原始分析结果完全分离**：处置记录写入独立的 dispositions.json，
 *   任何处置操作都不修改 analyses.json 中的分析结果（冲突字段、建议、集群保持原样）；
 * - **更新时间由操作者填写并原样保留**：客户端可提交 updatedAt（如手工调整过的
 *   datetime-local），服务端校验为合法时间后原样存储，不以服务端时钟覆盖；
 * - 追加式 history 保留每次状态/批注变更轨迹（创建记录即为首条）。
 */

const { pairKey } = require('./compare');

/** 处置状态：待处理（默认）/ 已确认 / 已解决 */
const DISPOSITION_STATUSES = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  RESOLVED: 'resolved',
};
const STATUS_LIST = ['pending', 'confirmed', 'resolved'];

/** 单条冲突处置历史上限，防止误操作刷爆 JSON 文件 */
const HISTORY_LIMIT = 200;

/** 处置校验失败：status 为建议 HTTP 状态码 */
class DispositionError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'DispositionError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/** 冲突记录 -> 稳定区域对键；无法构成区域对的异常记录返回 null */
function conflictPairKey(conflict) {
  const ids = [
    ...new Set(
      (conflict?.zones || [])
        .map((z) => (z && z.id !== undefined && z.id !== null ? String(z.id) : null))
        .filter(Boolean)
    ),
  ];
  return ids.length === 2 ? pairKey(ids[0], ids[1]) : null;
}

/** 规范化磁盘读出的处置文档结构（缺字段/损坏时容错） */
function normalizeDoc(rawDoc, analysisId) {
  const d = rawDoc && typeof rawDoc === 'object' ? rawDoc : {};
  return {
    analysisId,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
    entries: d.entries && typeof d.entries === 'object' && !Array.isArray(d.entries) ? d.entries : {},
  };
}

/**
 * 合并处置状态后的冲突视图（保持分析结果中冲突的原始顺序与字段，不修改原记录）。
 * @returns {Array} 每项为冲突展示字段 + 处置字段（status/comment/operator/时间/history）
 */
function buildDispositionView(record, rawDoc) {
  if (!record || !record.result || !Array.isArray(record.result.conflicts)) {
    throw new DispositionError('分析结果数据不完整（缺少 conflicts 列表），无法加载处置工作台');
  }
  const doc = normalizeDoc(rawDoc, record.id);
  return record.result.conflicts.map((c) => {
    const key = conflictPairKey(c);
    const saved = key ? doc.entries[key] : null;
    return {
      pairKey: key,
      conflictId: c.id,
      conflictType: c.conflictType,
      zones: c.zones || [],
      sharedResources: c.sharedResources || [],
      overlapStart: c.overlapStart,
      overlapEnd: c.overlapEnd,
      overlapDays: c.overlapDays,
      areaM2: c.areaM2,
      areaHectares: c.areaHectares,
      geometry: c.geometry || null,
      suggestions: Array.isArray(c.suggestions) ? c.suggestions : [],
      status: saved && STATUS_LIST.includes(saved.status) ? saved.status : DISPOSITION_STATUSES.PENDING,
      comment: saved ? String(saved.comment || '') : '',
      operator: saved ? String(saved.operator || '') : '',
      handled: !!saved,
      createdAt: saved ? saved.createdAt || null : null,
      updatedAt: saved ? saved.updatedAt || null : null,
      history: saved && Array.isArray(saved.history) ? saved.history : [],
    };
  });
}

/** 汇总计数：total / pending（含从未处置）/ confirmed / resolved / handled */
function summarizeItems(items) {
  const summary = { total: items.length, pending: 0, confirmed: 0, resolved: 0, handled: 0 };
  for (const it of items) {
    if (it.status === DISPOSITION_STATUSES.CONFIRMED) summary.confirmed += 1;
    else if (it.status === DISPOSITION_STATUSES.RESOLVED) summary.resolved += 1;
    else summary.pending += 1;
    if (it.handled) summary.handled += 1;
  }
  return summary;
}

/**
 * 不构造完整视图的轻量汇总（用于分析列表展示）。
 * 仅统计区域对仍存在于当前分析结果中的处置条目，分析重新生成后的残留条目不计入。
 */
function summarizeRecord(record, rawDoc) {
  if (!record || !record.result || !Array.isArray(record.result.conflicts)) return null;
  const entries = normalizeDoc(rawDoc, record?.id).entries;
  const items = record.result.conflicts.map((c) => {
    const key = conflictPairKey(c);
    const saved = key ? entries[key] : null;
    return { status: saved?.status, handled: !!saved };
  });
  return { ...summarizeItems(items), updatedAt: normalizeDoc(rawDoc, record?.id).updatedAt };
}

function normalizeStatus(value) {
  if (value === undefined || value === null || value === '') return DISPOSITION_STATUSES.PENDING;
  if (!STATUS_LIST.includes(value)) {
    throw new DispositionError(`处置状态无效（${String(value)}），仅支持 pending / confirmed / resolved`);
  }
  return value;
}

function normalizeText(value, fieldLabel, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new DispositionError(`${fieldLabel}必须为文本`);
  }
  const text = String(value).trim();
  if (text.length > maxLength) {
    throw new DispositionError(`${fieldLabel}长度不能超过 ${maxLength} 个字符`);
  }
  return text;
}

/**
 * 解析更新时间：操作者提交了合法时间则**原样保留**，未提交时回退服务端当前时间。
 * 这样既满足"状态变更保留操作者填写的更新时间"，也兼容脚本调用。
 */
function resolveUpdatedAt(value, nowIso) {
  if (value === undefined || value === null || value === '') return nowIso;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new DispositionError('更新时间格式无效，请填写有效的日期时间');
  }
  return value;
}

/**
 * 写入/更新一条冲突处置。
 * @param {Object} record 已保存分析记录（只读，函数内不修改其任何字段）
 * @param {Object|null} rawDoc 该分析既有处置文档（可为 null）
 * @param {Object} input { status?, comment?, operator?, updatedAt? }
 * @param {string} nowIso 服务端当前时间（ISO），未提交 updatedAt 时使用
 * @returns {{doc: Object, entry: Object, conflict: Object, changed: boolean}}
 */
function applyDisposition(record, rawDoc, input = {}, nowIso = new Date().toISOString()) {
  if (!record || !record.id) {
    throw new DispositionError('缺少有效的分析记录');
  }
  if (!record.result || !Array.isArray(record.result.conflicts)) {
    throw new DispositionError('分析结果数据不完整（缺少 conflicts 列表），无法保存处置');
  }

  const body = input && typeof input === 'object' ? input : {};
  const pairKeyParam = typeof body.pairKey === 'string' ? body.pairKey : null;

  // 区域对必须来自本次分析结果，防止向不存在/已漂移的冲突写入脏数据
  const conflictByPair = new Map();
  for (const c of record.result.conflicts) {
    const key = conflictPairKey(c);
    if (key) conflictByPair.set(key, c);
  }
  if (!pairKeyParam || !conflictByPair.has(pairKeyParam)) {
    throw new DispositionError('该区域对不在分析结果中（分析可能已重新生成），请重新打开处置工作台');
  }

  const status = normalizeStatus(body.status);
  const comment = normalizeText(body.comment, '批注', 2000);
  const operator = normalizeText(body.operator, '操作者', 100);
  const updatedAt = resolveUpdatedAt(body.updatedAt, nowIso);

  const doc = normalizeDoc(rawDoc, record.id);
  const existed = doc.entries[pairKeyParam];
  const changed = !existed
    || existed.status !== status
    || String(existed.comment || '') !== comment
    || String(existed.operator || '') !== operator;

  let entry;
  if (existed) {
    entry = existed;
  } else {
    entry = {
      pairKey: pairKeyParam,
      status,
      comment,
      operator,
      createdAt: updatedAt,
      updatedAt,
      history: [],
    };
  }

  if (changed) {
    entry.status = status;
    entry.comment = comment;
    entry.operator = operator;
    entry.updatedAt = updatedAt;
    entry.history.push({ at: updatedAt, status, comment, operator });
    if (entry.history.length > HISTORY_LIMIT) {
      entry.history.splice(0, entry.history.length - HISTORY_LIMIT);
    }
    doc.entries[pairKeyParam] = entry;
    doc.updatedAt = updatedAt;
  }

  return { doc, entry, conflict: conflictByPair.get(pairKeyParam), changed };
}

module.exports = {
  DISPOSITION_STATUSES,
  STATUS_LIST,
  DispositionError,
  conflictPairKey,
  buildDispositionView,
  summarizeItems,
  summarizeRecord,
  applyDisposition,
  normalizeDoc,
};
