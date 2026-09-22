'use strict';

// 冲突处置工作台测试：纯逻辑（区域对键 / 视图 / 汇总 / 状态写入）+ JSON 持久化往返
process.env.DATA_DIR = require('fs').mkdtempSync('/tmp/disposition-test-');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/analysis');
const { pairKey } = require('../src/compare');
const {
  DISPOSITION_STATUSES,
  conflictPairKey,
  buildDispositionView,
  summarizeItems,
  summarizeRecord,
  applyDisposition,
  DispositionError,
} = require('../src/disposition');
const store = require('../src/store');

function square(lon1, lat1, lon2, lat2) {
  return {
    type: 'Polygon',
    coordinates: [[[lon1, lat1], [lon2, lat1], [lon2, lat2], [lon1, lat2], [lon1, lat1]]],
  };
}

function zone(id, name, start, end, resources, lon) {
  return {
    id, name, layer: '土建',
    start: `${start}T00:00:00.000Z`,
    end: `${end}T00:00:00.000Z`,
    resources,
    geometry: square(lon, 31.25, lon + 0.004, 31.253),
  };
}

function makeRecord(id) {
  const result = analyze([
    zone('z1', 'A区', '2026-10-01', '2026-10-20', ['塔吊'], 121.500),
    zone('z2', 'B区', '2026-10-05', '2026-10-25', ['塔吊'], 121.501), // 与 A 空间+资源冲突
    zone('z3', 'C区', '2026-11-01', '2026-11-20', [], 121.600),       // 与 A/B 时间不重叠，无冲突
  ]);
  return { id, name: '处置测试分析', savedAt: '2026-09-01T00:00:00.000Z', result };
}

const record = makeRecord('a1');
assert.ok(record.result.conflicts.length >= 1, '夹具应至少产生一条冲突');
const conflict = record.result.conflicts[0];
const key = conflictPairKey(conflict);
assert.strictEqual(key, pairKey('z1', 'z2'), '区域对键应与对比模块的稳定键一致');

// 1. 初始视图：全部待处理、无批注、按原始结果顺序
let view = buildDispositionView(record, null);
assert.strictEqual(view.length, record.result.conflicts.length);
assert.deepStrictEqual(view.map((v) => v.conflictId), record.result.conflicts.map((c) => c.id));
assert.ok(view.every((v) => v.status === 'pending'));
assert.ok(view.every((v) => v.handled === false));
assert.ok(view.every((v) => v.comment === ''));

const summary0 = summarizeItems(view);
assert.deepStrictEqual(summary0, {
  total: view.length, pending: view.length, confirmed: 0, resolved: 0, handled: 0,
});

// 2. 写入「已确认」+ 批注，操作者填写的更新时间必须原样保留
const operatorTime = '2026-09-22T10:30:00.000+08:00';
let r1 = applyDisposition(record, null, {
  pairKey: key,
  status: 'confirmed',
  comment: '已与施工方确认，改为夜间作业',
  operator: '张工',
  updatedAt: operatorTime,
}, '2026-09-22T00:00:00.000Z');
assert.strictEqual(r1.changed, true);
assert.strictEqual(r1.entry.status, 'confirmed');
assert.strictEqual(r1.entry.updatedAt, operatorTime, '操作者填写的更新时间不得被服务端改写');
assert.strictEqual(r1.entry.createdAt, operatorTime);
assert.strictEqual(r1.entry.history.length, 1);
assert.strictEqual(r1.doc.updatedAt, operatorTime);

// 3. 同一内容重复提交不产生新历史（no-op）
const r1b = applyDisposition(record, r1.doc, {
  pairKey: key, status: 'confirmed', comment: '已与施工方确认，改为夜间作业', operator: '张工', updatedAt: operatorTime,
});
assert.strictEqual(r1b.changed, false);
assert.strictEqual(r1b.entry.history.length, 1);

// 4. 改为「已解决」并追加历史；未提交 updatedAt 时回退服务端时间
const r2 = applyDisposition(record, r1.doc, {
  pairKey: key, status: 'resolved', comment: '已调整完成', operator: '张工',
}, '2026-09-23T01:00:00.000Z');
assert.strictEqual(r2.entry.status, 'resolved');
assert.strictEqual(r2.entry.updatedAt, '2026-09-23T01:00:00.000Z');
assert.strictEqual(r2.entry.createdAt, operatorTime, 'createdAt 保持首次处置时间');
assert.strictEqual(r2.entry.history.length, 2, '历史应追加而非覆盖');
assert.strictEqual(r2.entry.history[0].status, 'confirmed');
assert.strictEqual(r2.entry.history[1].status, 'resolved');

// 5. 重新构建视图时状态与批注恢复
view = buildDispositionView(record, r2.doc);
const item = view.find((v) => v.pairKey === key);
assert.strictEqual(item.status, 'resolved');
assert.strictEqual(item.comment, '已调整完成');
assert.strictEqual(item.operator, '张工');
assert.strictEqual(item.handled, true);
const summary1 = summarizeItems(view);
assert.strictEqual(summary1.resolved, 1);
assert.strictEqual(summary1.pending, view.length - 1);
assert.strictEqual(summary1.handled, 1);

// 6. 非法输入
assert.throws(
  () => applyDisposition(record, null, { pairKey: key, status: 'done' }, 'x'),
  (e) => e instanceof DispositionError && e.status === 400
);
assert.throws(
  () => applyDisposition(record, null, { pairKey: 'no-such-pair', status: 'pending' }, 'x'),
  /不在分析结果中/
);
assert.throws(
  () => applyDisposition(record, null, { pairKey: key, updatedAt: 'not-a-date' }, 'x'),
  /更新时间格式无效/
);
assert.throws(
  () => applyDisposition(record, null, { pairKey: key, comment: { oops: 1 } }, 'x'),
  /批注必须为文本/
);

// 7. 不得改写原始分析结果
const before = JSON.stringify(record.result.conflicts);
const cloneDoc = JSON.parse(JSON.stringify(r2.doc));
const discard = applyDisposition(record, cloneDoc, { pairKey: key, status: 'pending', comment: '复核中' }, '2026-09-24T00:00:00.000Z');
assert.strictEqual(JSON.stringify(record.result.conflicts), before, '处置写入不得修改分析结果的任何字段');
assert.strictEqual(discard.entry.status, 'pending');
assert.strictEqual(r2.doc.entries[key].status, 'resolved', '原始 r2.doc 不应被克隆上的操作影响');

// 8. 重新生成分析后，残留条目不进入汇总（summarizeRecord 只统计现存区域对）
const staleDoc = {
  analysisId: 'a1',
  updatedAt: '2026-09-24T00:00:00.000Z',
  entries: { 'old-zone-x::old-zone-y': { pairKey: 'old-zone-x::old-zone-y', status: 'resolved', comment: '', operator: '', history: [] } },
};
const lightSummary = summarizeRecord(record, staleDoc);
assert.strictEqual(lightSummary.pending, record.result.conflicts.length, '残留条目不应计入');

// 损坏文档容错（entries 缺失/非对象）
const tolerant = buildDispositionView(record, { analysisId: 'a1' });
assert.ok(tolerant.every((v) => v.status === 'pending'));

// 9. 持久化往返：写入独立 dispositions.json，与 analyses.json 分离
store.saveAnalysis(JSON.parse(JSON.stringify(record)));
store.saveDispositions(r2.doc);
const file = path.join(process.env.DATA_DIR, 'dispositions.json');
assert.ok(fs.existsSync(file), '处置数据应写入 DATA_DIR 下的 dispositions.json');
const reloaded = store.getDispositions('a1');
assert.strictEqual(reloaded.entries[key].status, 'resolved');
assert.strictEqual(reloaded.entries[key].history.length, 2);
const viewAfterReload = buildDispositionView(store.getAnalysis('a1'), reloaded);
assert.strictEqual(viewAfterReload.find((v) => v.pairKey === key).comment, '已调整完成');

// 删除分析时级联删除处置文档
assert.strictEqual(store.deleteDispositions('a1'), true);
assert.strictEqual(store.getDispositions('a1'), null);
assert.strictEqual(store.deleteDispositions('a1'), false);

// 历史上限保护
let doc = null;
const big = applyDisposition(record, null, { pairKey: key, status: 'confirmed', comment: 'c0' }, '2026-01-01T00:00:00.000Z');
doc = big.doc;
for (let i = 1; i <= 250; i++) {
  const r = applyDisposition(record, doc, {
    pairKey: key,
    status: i % 2 ? 'confirmed' : 'resolved',
    comment: `c${i}`,
  }, `2026-01-${String(Math.min(i + 1, 28)).padStart(2, '0')}T00:00:00.000Z`);
  doc = r.doc;
}
assert.strictEqual(doc.entries[key].history.length, 200, '历史超出上限后应截断保留最近 200 条');

assert.strictEqual(DISPOSITION_STATUSES.PENDING, 'pending');

// 清理临时 DATA_DIR
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log('disposition tests passed');
