'use strict';

/**
 * 冲突处置工作台（Conflict Disposition Workbench）
 *
 * 对**已保存分析**中的冲突逐条登记处置结论。核心原则：
 * - 以**稳定的区域对键**（与分析对比一致：两个区域 id 排序后拼接，不依赖
 *   `conflict-N` 编号——编号会随冲突增减与面积排序漂移）标识每条冲突；
 * - 状态：pending 待处理 / confirmed 已确认 / resolved 已解决；
 * - 每次更新保留**操作者填写的更新时间**（updatedAt；未传时由服务端补当前
 *   时间），并把每次变更追加进 history，历史只增不改；
 * - 批注可随时增改（长度受限），不传 comment 时保留上一次批注；
 * - 处置数据与原始分析结果**完全分离**，本模块只做纯计算，持久化由 store 负责，
 *   任何路径都不会改写 analyze() 产出的原始结果。
 */

/** 处置状态：待处理 / 已确认 / 已解决 */
const DISPOSITION_STATUSES = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  RESOLVED: 'resolved',
});
const STATUS_VALUES = Object.freeze(Object.values(DISPOSITION_STATUSES));
const STATUS_LABELS = Object.freeze({
  pending: '待处理',
  confirmed: '已确认',
  resolved: '已解决',
});

/** 批注长度上限（单条，按字符计），防止异常超长写入 */
const MAX_COMMENT_LENGTH = 2000;

/** 处置入参/数据错误：status 建议 HTTP 状态码（400 入参无效） */
class DispositionError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'DispositionError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/** 区域对匹配键：区域 id 排序后用分隔符拼接（与 compare.pairKey 保持一致） */
function pairKey(zoneAId, zoneBId) {
  return [String(zoneAId), String(zoneBId)].sort().join('::');
}

/** 取一条冲突涉及的两个区域 id（去重、过滤空值）；非恰好两个区域返回 null */
function conflictZoneIds(conflict) {
  const ids = [
    ...new Set(
      (conflict.zones || [])
        .map((z) => (z && z.id !== undefined && z.id !== null ? String(z.id) : null))
        .filter(Boolean)
    ),
  ];
  return ids.length === 2 ? ids : null;
}

function conflictPairKey(conflict) {
  const ids = conflictZoneIds(conflict);
  if (!ids) {
    throw new DispositionError('冲突记录缺少两个有效区域，无法生成稳定区域对键');
  }
  return pairKey(ids[0], ids[1]);
}

/** 校验分析结果结构（处置工作台必须基于完整的已保存结果） */
function requireResult(result) {
  if (!result || !Array.isArray(result.conflicts)) {
    throw new DispositionError('该分析结果数据不完整（缺少 conflicts 列表），无法登记处置');
  }
  return result;
}

function normalizeStatus(value) {
  if (typeof value !== 'string' || !STATUS_VALUES.includes(value)) {
    throw new DispositionError('处置状态必须是 pending（待处理）/ confirmed（已确认）/ resolved（已解决）之一');
  }
  return value;
}

/**
 * 规范化批注：必须是文本，去首尾空白，超长拒绝。
 * undefined 表示本次调用未提供批注（由调用方决定是否沿用历史值）；null 视同清空。
 */
function normalizeComment(value) {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value !== 'string') {
    throw new DispositionError('批注必须是文本内容');
  }
  const comment = value.trim();
  if (comment.length > MAX_COMMENT_LENGTH) {
    throw new DispositionError(`批注过长（最多 ${MAX_COMMENT_LENGTH} 字，当前 ${comment.length} 字）`);
  }
  return comment;
}

/**
 * 解析操作者填写的更新时间：
 * - 传了可解析的时间字符串则原样保留（归一化为 ISO，**不被服务端时间覆盖**）；
 * - 未传 / 空串则由服务端补当前时间。
 */
function resolveUpdatedAt(value, now = new Date()) {
  if (value === undefined || value === null || value === '') {
    return now.toISOString();
  }
  if (typeof value !== 'string') {
    throw new DispositionError('更新时间必须是有效的时间字符串');
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new DispositionError('更新时间不是有效的时间，请重新选择');
  }
  return new Date(t).toISOString();
}

/**
 * 把分析结果展开为按稳定区域对标识的处置条目，保持结果中的稳定顺序
 * （analyze 已按重叠面积降序、重叠天数兜底排序）。
 * 同一区域对异常出现多条冲突时只保留第一条（analyze 保证一对区域至多一条）。
 * @returns {Array<{pairKey, conflictId, conflictType, zones, sharedResources,
 *                  overlapStart, overlapEnd, overlapDays, areaM2, clusterId}>}
 */
function buildEntries(result) {
  requireResult(result);
  const clusterIndex = new Map();
  (result.clusters || []).forEach((cl) => {
    (cl.conflictIds || []).forEach((cid) => clusterIndex.set(cid, cl.id));
  });

  const entries = [];
  const seen = new Set();
  for (const c of result.conflicts) {
    const ids = conflictZoneIds(c);
    if (!ids) continue;
    const key = pairKey(ids[0], ids[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      pairKey: key,
      conflictId: c.id,
      conflictType: c.conflictType,
      zones: (c.zones || []).map((z) => ({
        id: String(z.id),
        name: z.name != null ? String(z.name) : String(z.id),
        layer: z.layer != null ? String(z.layer) : '',
      })),
      sharedResources: Array.isArray(c.sharedResources) ? c.sharedResources.map(String) : [],
      overlapStart: c.overlapStart || null,
      overlapEnd: c.overlapEnd || null,
      overlapDays: Number.isFinite(Number(c.overlapDays)) ? Number(c.overlapDays) : null,
      areaM2: Number.isFinite(Number(c.areaM2)) ? Number(c.areaM2) : 0,
      clusterId: clusterIndex.get(c.id) || null,
    });
  }
  return entries;
}

/** 把已持久化的处置记录挂到条目上（无记录为 null，即「未处置」） */
function attachDispositions(entries, items) {
  return entries.map((e) => ({ ...e, disposition: items[e.pairKey] || null }));
}

/**
 * 汇总计数：total 区域对总数；untouched 尚未处置；handled 已处置；
 * pending / confirmed / resolved 按当前状态统计（忽略未知状态的脏记录）。
 */
function summarize(entries, items) {
  const counts = {
    total: entries.length,
    handled: 0,
    untouched: entries.length,
    pending: 0,
    confirmed: 0,
    resolved: 0,
  };
  for (const e of entries) {
    const rec = items[e.pairKey];
    if (rec && STATUS_VALUES.includes(rec.status)) {
      counts.handled += 1;
      counts.untouched -= 1;
      counts[rec.status] += 1;
    }
  }
  return counts;
}

/** 仅按持久化条目计数（用于已保存分析列表，不依赖展开冲突条目） */
function countItems(items) {
  const counts = { handled: 0, pending: 0, confirmed: 0, resolved: 0 };
  for (const rec of Object.values(items || {})) {
    if (rec && STATUS_VALUES.includes(rec.status)) {
      counts.handled += 1;
      counts[rec.status] += 1;
    }
  }
  return counts;
}

/**
 * 应用一次处置更新（纯函数：不修改入参 items）。
 * @param {Object} items 已持久化的 pairKey -> 处置记录
 * @param {Object} input {pairKey, status, comment?, updatedAt?}
 * @returns {{record: Object, items: Object, previous: Object|null}}
 *   record 为更新后的记录（含追加后的 history）；items 为新映射
 */
function applyDisposition(items, input) {
  if (!input || typeof input !== 'object') {
    throw new DispositionError('缺少处置内容（状态 / 批注）');
  }
  if (typeof input.pairKey !== 'string' || !input.pairKey.includes('::')) {
    throw new DispositionError('缺少有效的区域对键（pairKey）');
  }
  const key = input.pairKey;
  const status = normalizeStatus(input.status);
  const commentRaw = normalizeComment(input.comment);
  const updatedAt = resolveUpdatedAt(input.updatedAt);

  const previous = items[key] || null;
  // 未显式传 comment（undefined）时保留上一次批注；显式空串则清空
  const comment = commentRaw === undefined ? (previous ? previous.comment || '' : '') : commentRaw;

  // 历史只增不改：每次提交都作为一条变更留痕（状态 / 批注 / 更新时间）
  const event = { status, comment, updatedAt };
  const history = Array.isArray(previous?.history) && previous.history.length
    ? [...previous.history, event]
    : [event];

  const record = { pairKey: key, status, comment, updatedAt, history };
  return { record, previous, items: { ...items, [key]: record } };
}

module.exports = {
  DISPOSITION_STATUSES,
  STATUS_VALUES,
  STATUS_LABELS,
  MAX_COMMENT_LENGTH,
  DispositionError,
  pairKey,
  conflictPairKey,
  conflictZoneIds,
  buildEntries,
  attachDispositions,
  summarize,
  countItems,
  normalizeStatus,
  normalizeComment,
  resolveUpdatedAt,
  applyDisposition,
};
