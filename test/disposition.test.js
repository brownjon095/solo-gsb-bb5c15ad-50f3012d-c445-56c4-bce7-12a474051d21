'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { analyze } = require('../src/analysis');
const {
  STATUS_VALUES,
  STATUS_LABELS,
  MAX_COMMENT_LENGTH,
  DispositionError,
  pairKey,
  buildEntries,
  attachDispositions,
  summarize,
  countItems,
  applyDisposition,
  resolveUpdatedAt,
  normalizeComment,
} = require('../src/disposition');

function square(lon1, lat1, lon2, lat2) {
  return {
    type: 'Polygon',
    coordinates: [[[lon1, lat1], [lon2, lat1], [lon2, lat2], [lon1, lat2], [lon1, lat1]]],
  };
}

function zone(id, { start, end, resources = [] } = {}) {
  return {
    id, name: id, layer: 'L',
    start: start || '2026-10-01T00:00:00.000Z',
    end: end || '2026-11-30T00:00:00.000Z',
    resources,
    geometry: square(121.470, 31.228, 121.475, 31.232),
  };
}

const result = analyze([
  zone('z1'),
  zone('z2', { resources: ['塔吊'] }),
  zone('z3', { resources: ['塔吊'] }), // z2×z3 同时空间+资源 -> both
]);

// 三区域两两相交 -> 3 对冲突
assert.strictEqual(result.conflictCount, 3);
const entries = buildEntries(result);
assert.strictEqual(entries.length, 3, '应按区域对展开 3 条处置条目');

// 1. 稳定区域对键：与参数顺序无关，不依赖 conflict-N 编号
assert.strictEqual(pairKey('z2', 'z1'), 'z1::z2');
assert.strictEqual(pairKey('z1', 'z2'), 'z1::z2');
const expectedKeys = new Set(['z1::z2', 'z1::z3', 'z2::z3']);
for (const e of entries) {
  assert.ok(expectedKeys.has(e.pairKey), `区域对键异常：${e.pairKey}`);
  assert.strictEqual(e.zones.length, 2);
}
// 顺序与分析结果一致（面积/重叠天数稳定排序）
assert.deepStrictEqual(entries.map((e) => e.pairKey), result.conflicts.map((c) => {
  const ids = c.zones.map((z) => z.id).sort();
  return ids.join('::');
}));
// both 冲突携带共享资源，纯空间冲突为空数组
const both = entries.find((e) => e.pairKey === 'z2::z3');
assert.strictEqual(both.conflictType, 'both');
assert.deepStrictEqual(both.sharedResources, ['塔吊']);
const onlySpatial = entries.find((e) => e.pairKey === 'z1::z2');
assert.deepStrictEqual(onlySpatial.sharedResources, []);

// 集群关联：3 个区域两两冲突构成一个集群
assert.strictEqual(entries.every((e) => e.clusterId === 'cluster-1'), true);

// 2. 汇总计数：初始全部「未处置」
let summary = summarize(entries, {});
assert.deepStrictEqual(summary, {
  total: 3, handled: 0, untouched: 3, pending: 0, confirmed: 0, resolved: 0,
});

// 3. 登记处置：pending + 批注 + 操作者指定更新时间（必须原样保留，不被服务端时间覆盖）
const operatorTime = '2026-09-20T08:30:00.000Z';
let applied = applyDisposition({}, {
  pairKey: 'z1::z2', status: 'pending', comment: '  已联系分包商，待 9/25 协调会确认  ', updatedAt: operatorTime,
});
assert.strictEqual(applied.record.status, 'pending');
assert.strictEqual(applied.record.comment, '已联系分包商，待 9/25 协调会确认', '批注应去首尾空白');
assert.strictEqual(applied.record.updatedAt, operatorTime, '操作者填写的更新时间必须保留');
assert.strictEqual(applied.record.history.length, 1);
let items = applied.items;

summary = summarize(entries, items);
assert.deepStrictEqual(
  { ...summary },
  { total: 3, handled: 1, untouched: 2, pending: 1, confirmed: 0, resolved: 0 }
);
assert.deepStrictEqual(countItems(items), { handled: 1, pending: 1, confirmed: 0, resolved: 0 });

// 4. 再次更新：改为已解决、未传 comment 时保留旧批注；未传 updatedAt 时服务端补当前时间
const beforeNow = Date.now();
applied = applyDisposition(items, { pairKey: 'z1::z2', status: 'resolved' });
items = applied.items;
assert.strictEqual(applied.record.comment, '已联系分包商，待 9/25 协调会确认', '未传批注时应保留上一次批注');
assert.ok(Date.parse(applied.record.updatedAt) >= beforeNow, '未传更新时间时应取服务端当前时间');
assert.strictEqual(applied.record.history.length, 2, '历史只增不改，应保留两条');
assert.strictEqual(applied.record.history[0].status, 'pending');
assert.strictEqual(applied.record.history[1].status, 'resolved');
summary = summarize(entries, items);
assert.strictEqual(summary.resolved, 1);
assert.strictEqual(summary.pending, 0);

// 5. 显式空批注清空；已确认状态
items = applyDisposition(items, {
  pairKey: 'z1::z3', status: 'confirmed', comment: '', updatedAt: '2026-09-21T10:00',
}).items;
const rec = items['z1::z3'];
assert.strictEqual(rec.status, 'confirmed');
assert.strictEqual(rec.comment, '', '显式空批注应清空');
assert.strictEqual(rec.updatedAt, '2026-09-21T10:00:00.000Z', '非 UTC 时间应归一化为 ISO');

// 6. attachDispositions：无记录的区域对 disposition 为 null（未处置）
const attached = attachDispositions(entries, items);
const withRec = attached.find((e) => e.pairKey === 'z1::z3');
assert.strictEqual(withRec.disposition.status, 'confirmed');
const withoutRec = attached.find((e) => e.pairKey === 'z2::z3');
assert.strictEqual(withoutRec.disposition, null);

// 7. 入参校验
assert.throws(
  () => applyDisposition(items, { pairKey: 'z1::z2', status: 'done' }),
  (err) => err instanceof DispositionError && err.message.includes('处置状态')
);
assert.throws(
  () => applyDisposition(items, { pairKey: 'badkey', status: 'pending' }),
  /区域对键/
);
assert.throws(
  () => applyDisposition(items, { pairKey: 'z1::z2', status: 'pending', updatedAt: 'not-a-date' }),
  /更新时间/
);
assert.throws(
  () => normalizeComment({ x: 1 }),
  /批注必须是文本/
);
assert.throws(
  () => applyDisposition(items, { pairKey: 'z1::z2', status: 'pending', comment: 'x'.repeat(MAX_COMMENT_LENGTH + 1) }),
  /批注过长/
);
// null 批注视同清空
assert.strictEqual(normalizeComment(null), '');
// 未提供更新时间 -> 当前 ISO 时间；默认时间可注入
assert.strictEqual(resolveUpdatedAt('', new Date('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00.000Z');

// 状态枚举与中文标签稳定
assert.deepStrictEqual(STATUS_VALUES, ['pending', 'confirmed', 'resolved']);
assert.strictEqual(STATUS_LABELS.resolved, '已解决');

// 8. 损坏结果 / 脏数据容错
assert.throws(() => buildEntries({}), (err) => err instanceof DispositionError);
const dirty = {
  'z1::z2': { status: 'unknown-status', comment: 'x', updatedAt: operatorTime, history: [] },
};
summary = summarize(entries, dirty);
assert.strictEqual(summary.handled, 0, '未知状态的脏记录不计入已处置');
assert.strictEqual(summary.untouched, 3);
assert.deepStrictEqual(countItems(dirty), { handled: 0, pending: 0, confirmed: 0, resolved: 0 });

// 9. store 持久化（独立临时 DATA_DIR）：处置数据写入持久化目录，且不改写原始分析
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-test-'));
process.env.DATA_DIR = tmpDir;
delete require.cache[require.resolve('../src/store')];
const store = require('../src/store');

const analysisId = 'analysis-test-1';
const record = {
  id: analysisId,
  name: '处置测试分析',
  savedAt: new Date().toISOString(),
  params: {},
  result,
};
store.saveAnalysis(record);
assert.deepStrictEqual(store.listDispositions(analysisId), {}, '新分析无处置记录');

store.upsertDisposition(analysisId, 'z1::z2', applyDisposition({}, {
  pairKey: 'z1::z2', status: 'pending', comment: '待协调', updatedAt: operatorTime,
}).record);
assert.ok(fs.existsSync(path.join(tmpDir, 'dispositions.json')), '处置数据应落盘到 DATA_DIR/dispositions.json');

// 重新从磁盘读取（模拟重新打开分析）
const reloaded = store.listDispositions(analysisId);
assert.strictEqual(reloaded['z1::z2'].status, 'pending');
assert.strictEqual(reloaded['z1::z2'].comment, '待协调');
assert.strictEqual(reloaded['z1::z2'].updatedAt, operatorTime);

// 原始分析结果不被任何处置操作改写
const untouchedRecord = store.getAnalysis(analysisId);
assert.deepStrictEqual(untouchedRecord.result.conflicts, result.conflicts);
assert.ok(!('disposition' in untouchedRecord.result), '处置数据不得写入原始分析结果');

// 不同分析的处置数据互相隔离
store.upsertDisposition('other-analysis', 'a::b', {
  pairKey: 'a::b', status: 'resolved', comment: '', updatedAt: operatorTime, history: [],
});
assert.strictEqual(store.listDispositions(analysisId)['a::b'], undefined);
assert.strictEqual(store.listDispositions('other-analysis')['a::b'].status, 'resolved');

// 删除分析时级联清理其处置记录，不影响其他分析
assert.strictEqual(store.deleteAnalysis(analysisId), true);
assert.deepStrictEqual(store.listDispositions(analysisId), {});
assert.strictEqual(store.listDispositions('other-analysis')['a::b'].status, 'resolved');
// 删除不存在的分析返回 false
assert.strictEqual(store.deleteAnalysis(analysisId), false);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('disposition.test.js OK');
