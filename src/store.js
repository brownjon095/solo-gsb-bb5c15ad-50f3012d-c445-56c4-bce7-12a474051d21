'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ZONES_FILE = path.join(DATA_DIR, 'zones.json');
const ANALYSES_FILE = path.join(DATA_DIR, 'analyses.json');
// 冲突处置数据独立文件：与原始分析结果分离，任何处置操作都不改写 analyses.json
const DISPOSITIONS_FILE = path.join(DATA_DIR, 'dispositions.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // 原子替换，避免写一半损坏
}

// ---- 区域（zones） ----

function listZones() {
  return readJson(ZONES_FILE, []);
}

function saveZones(zones) {
  writeJson(ZONES_FILE, zones);
}

function addZones(newZones) {
  const zones = listZones();
  zones.push(...newZones);
  saveZones(zones);
  return zones;
}

function deleteZone(id) {
  const zones = listZones();
  const next = zones.filter((z) => z.id !== id);
  saveZones(next);
  return zones.length !== next.length;
}

function clearZones() {
  saveZones([]);
}

// ---- 已保存的分析 ----

function listAnalyses() {
  return readJson(ANALYSES_FILE, []);
}

function getAnalysis(id) {
  return listAnalyses().find((a) => a.id === id) || null;
}

function saveAnalysis(record) {
  const analyses = listAnalyses();
  analyses.push(record);
  writeJson(ANALYSES_FILE, analyses);
  return record;
}

function deleteAnalysis(id) {
  const analyses = listAnalyses();
  const next = analyses.filter((a) => a.id !== id);
  writeJson(ANALYSES_FILE, next);
  if (analyses.length !== next.length) {
    // 分析被删除后其处置记录失去依附，级联清理（不影响其他分析）
    deleteDispositions(id);
    return true;
  }
  return false;
}

// ---- 冲突处置（按分析 id 隔离；每条记录以稳定区域对键 pairKey 索引）----
// 结构：{ [analysisId]: { [pairKey]: { pairKey, status, comment, updatedAt, history[] } } }
function readDispositionsAll() {
  const data = readJson(DISPOSITIONS_FILE, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function writeDispositionsAll(data) {
  writeJson(DISPOSITIONS_FILE, data);
}

function listDispositions(analysisId) {
  const all = readDispositionsAll();
  const group = all[analysisId];
  return group && typeof group === 'object' && !Array.isArray(group) ? group : {};
}

/** 写入一条处置记录（整体替换该 pairKey 的记录；history 由上层构建），返回更新后的分组 */
function upsertDisposition(analysisId, pairKey, record) {
  const all = readDispositionsAll();
  const group = all[analysisId] && typeof all[analysisId] === 'object' && !Array.isArray(all[analysisId])
    ? all[analysisId]
    : {};
  group[pairKey] = record;
  all[analysisId] = group;
  writeDispositionsAll(all);
  return group;
}

/** 删除一条分析下的全部处置记录（删除分析时级联调用） */
function deleteDispositions(analysisId) {
  const all = readDispositionsAll();
  if (!Object.prototype.hasOwnProperty.call(all, analysisId)) return false;
  delete all[analysisId];
  writeDispositionsAll(all);
  return true;
}

module.exports = {
  listZones,
  addZones,
  deleteZone,
  clearZones,
  listAnalyses,
  getAnalysis,
  saveAnalysis,
  deleteAnalysis,
  listDispositions,
  upsertDisposition,
  deleteDispositions,
};
