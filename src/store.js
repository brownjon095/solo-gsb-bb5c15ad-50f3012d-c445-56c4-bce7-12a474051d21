'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ZONES_FILE = path.join(DATA_DIR, 'zones.json');
const ANALYSES_FILE = path.join(DATA_DIR, 'analyses.json');
// 冲突处置数据独立存放：与原始分析结果分离，任何处置操作都不改写 analyses.json
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
  return analyses.length !== next.length;
}

// ---- 冲突处置（按分析 id 分组，与分析结果分离持久化）----

/** 全部处置文档（Map-like 数组）：{analysisId, updatedAt, entries: {pairKey -> entry}} */
function listDispositions() {
  return readJson(DISPOSITIONS_FILE, []);
}

function getDispositions(analysisId) {
  return listDispositions().find((d) => d.analysisId === analysisId) || null;
}

/**
 * 保存某条分析的处置文档（整体替换该分析的文档，其他分析不受影响）。
 * @param {Object} doc {analysisId, updatedAt, entries}
 */
function saveDispositions(doc) {
  const all = listDispositions();
  const idx = all.findIndex((d) => d.analysisId === doc.analysisId);
  if (idx >= 0) all[idx] = doc;
  else all.push(doc);
  writeJson(DISPOSITIONS_FILE, all);
  return doc;
}

/** 删除分析时级联清理其处置文档 */
function deleteDispositions(analysisId) {
  const all = listDispositions();
  const next = all.filter((d) => d.analysisId !== analysisId);
  if (next.length !== all.length) writeJson(DISPOSITIONS_FILE, next);
  return next.length !== all.length;
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
  getDispositions,
  saveDispositions,
  deleteDispositions,
};
