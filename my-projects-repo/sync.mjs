#!/usr/bin/env node
/**
 * sync.mjs — 把源目录里的项目同步进本仓库的 projects/ 并更新 projects.json
 *
 * 特性：
 *   - 幂等：可重复执行，已存在的项目整体覆盖更新，不会产生重复条目
 *   - 源目录中已删除的项目，会从 projects.json 移除，原文件夹移入 .trash/<时间戳>/（不直接删除）
 *   - 绝不修改根目录的 index.html，你的自定义样式不会被覆盖
 *   - 保留你手工在 projects.json 里写的 desc / title 以及自定义字段
 *
 * 用法：
 *   node sync.mjs                     使用配置里的源目录
 *   node sync.mjs --src "D:\\some\\dir"  临时指定源目录
 *   node sync.mjs --refresh-meta      重新抓取所有项目的 title/description（覆盖手写内容）
 *   node sync.mjs --keep-orphans      源里已删除的项目只从索引移除，文件夹留在原地
 *   node sync.mjs --purge             清空 .trash/ 里的历史备份
 *   node sync.mjs --dry-run           只打印将要做什么，不落盘
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = path.join(ROOT, 'projects');
const INDEX_FILE = path.join(ROOT, 'projects.json');
const CONFIG_FILE = path.join(ROOT, 'sync.config.json');
const TRASH_DIR = path.join(ROOT, '.trash');
const DEFAULT_SOURCE = 'C:\\Users\\ZhuanZ\\Desktop\\s';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const val = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
};

const DRY_RUN = has('--dry-run');
const REFRESH_META = has('--refresh-meta');
const KEEP_ORPHANS = has('--keep-orphans');
const PURGE = has('--purge');

// ---------- 源目录 ----------
function resolveSource() {
  const fromCli = val('--src');
  if (fromCli) return path.resolve(fromCli);

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg.source) return path.resolve(cfg.source);
    } catch {
      console.warn('⚠️  sync.config.json 解析失败，改用默认源目录');
    }
  } else {
    const cfg = {
      source: DEFAULT_SOURCE,
      _comment: '把 source 改成你的项目源目录；子文件夹和一个散落的 .html 文件都算作一个项目。',
    };
    if (!DRY_RUN) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    }
  }
  return DEFAULT_SOURCE;
}

// ---------- 工具 ----------
const IGNORED = new Set([
  '.git', '.github', 'node_modules', '__pycache__', '.venv', 'venv',
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.idea', '.vscode',
]);
const HTML_EXT = new Set(['.html', '.htm']);
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

function sanitizeName(raw) {
  let n = raw.replace(ILLEGAL, '-').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').trim();
  if (!n) n = 'project';
  return n;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function readMeta(entryHtmlPath) {
  let head = '';
  try {
    head = fs.readFileSync(entryHtmlPath, 'utf8').slice(0, 200000);
  } catch {
    return { title: '', desc: '' };
  }
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch =
    head.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    head.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i) ||
    head.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i);

  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  let desc = descMatch ? decodeEntities(descMatch[1]).replace(/\s+/g, ' ').trim() : '';
  if (desc.length > 140) desc = desc.slice(0, 138).trimEnd() + '…';
  return { title, desc };
}

// ---------- 扫描源目录 ----------
function scanSource(src) {
  const items = [];
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const full = path.join(src, e.name);

    if (e.isDirectory()) {
      items.push({ kind: 'dir', rawName: e.name, srcPath: full });
    } else if (HTML_EXT.has(path.extname(e.name).toLowerCase())) {
      items.push({
        kind: 'file',
        rawName: path.basename(e.name, path.extname(e.name)),
        srcPath: full,
      });
    }
  }
  return items;
}

// ---------- 主流程 ----------
function main() {
  const SRC = resolveSource();

  if (!fs.existsSync(SRC)) {
    console.error(`❌ 源目录不存在：${SRC}`);
    console.error('   用 --src "路径" 指定，或修改 sync.config.json 里的 source。');
    process.exit(1);
  }

  if (PURGE) {
    if (fs.existsSync(TRASH_DIR)) {
      if (DRY_RUN) console.log(`[dry-run] 将清空 ${TRASH_DIR}`);
      else {
        fs.rmSync(TRASH_DIR, { recursive: true, force: true });
        console.log('🗑️  已清空 .trash/');
      }
    } else {
      console.log('.trash/ 不存在，无需清理。');
    }
    return;
  }

  console.log(`📂 源目录：${SRC}`);
  console.log(`📦 仓库目录：${ROOT}${DRY_RUN ? '   (dry-run，不写盘)' : ''}`);

  // 读取现有索引，保留手工内容
  let previous = [];
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      previous = Array.isArray(parsed) ? parsed : Array.isArray(parsed.projects) ? parsed.projects : [];
    } catch {
      console.warn('⚠️  projects.json 解析失败，将重建索引');
      previous = [];
    }
  }
  const prevByName = new Map(previous.filter((p) => p && p.name).map((p) => [p.name, p]));

  const items = scanSource(SRC);
  if (!items.length) {
    console.warn('⚠️  源目录里没有发现任何项目（子文件夹或 .html 文件）。');
  }

  if (!DRY_RUN) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

  const usedNames = new Set();
  const nextEntries = [];
  let copied = 0;
  let updated = 0;

  for (const item of items) {
    let name = sanitizeName(item.rawName);
    if (usedNames.has(name.toLowerCase())) {
      let i = 2;
      while (usedNames.has(`${name}-${i}`.toLowerCase())) i++;
      name = `${name}-${i}`;
    }
    usedNames.add(name.toLowerCase());

    const destDir = path.join(PROJECTS_DIR, name);
    const relPath = `projects/${name}`;
    const existed = fs.existsSync(destDir);

    if (!DRY_RUN) {
      // 先清空再复制，保证是源目录的精确镜像（旧文件不会残留）
      fs.rmSync(destDir, { recursive: true, force: true });
      if (item.kind === 'dir') {
        fs.cpSync(item.srcPath, destDir, {
          recursive: true,
          force: true,
          filter: (s) => !IGNORED.has(path.basename(s)),
        });
      } else {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(item.srcPath, path.join(destDir, 'index.html'));
      }

      // 规则 3：根目录没有 index.html 但只有一个 html 文件 → 重命名为 index.html
      const indexHtml = path.join(destDir, 'index.html');
      if (!fs.existsSync(indexHtml)) {
        const topHtml = fs
          .readdirSync(destDir, { withFileTypes: true })
          .filter((e) => e.isFile() && HTML_EXT.has(path.extname(e.name).toLowerCase()))
          .map((e) => e.name);
        if (topHtml.length === 1) {
          const from = path.join(destDir, topHtml[0]);
          fs.renameSync(from, indexHtml);
          console.log(`   ↳ 将 ${topHtml[0]} 重命名为 index.html`);
        }
      }
    }

    const meta = DRY_RUN
      ? { title: '', desc: '' }
      : readMeta(path.join(destDir, 'index.html'));

    const prev = prevByName.get(name);
    // 保留手工写的 desc/title（除非 --refresh-meta），未知自定义字段也保留
    const entry = { ...(prev || {}) };
    entry.name = name;
    entry.title = REFRESH_META || !prev?.title ? meta.title || prev?.title || name : prev.title;
    entry.desc = REFRESH_META || !prev?.desc ? meta.desc || prev?.desc || '' : prev.desc;
    entry.path = relPath;

    nextEntries.push(entry);
    if (existed) updated++;
    else copied++;
    console.log(`   ${existed ? '♻️  更新' : '➕ 新增'}  projects/${name}`);
  }

  // 排序：按 name 码点稳定排序（ASCII 在前、中文在后），避免每次 diff 抖动
  nextEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // ---------- 源目录已删除的项目 ----------
  const nextNames = new Set(nextEntries.map((e) => e.name));
  const orphans = previous.filter((p) => p?.name && !nextNames.has(p.name));

  if (orphans.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const o of orphans) {
      const dir = path.join(PROJECTS_DIR, o.name);
      if (KEEP_ORPHANS) {
        console.log(`   ⏭️  源已删除，仅从索引移除：projects/${o.name}（文件夹保留）`);
        continue;
      }
      if (fs.existsSync(dir)) {
        const target = path.join(TRASH_DIR, stamp, o.name);
        if (!DRY_RUN) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(dir, target);
        }
        console.log(`   🗑️  源已删除：projects/${o.name} → .trash/${stamp}/${o.name}`);
      } else {
        console.log(`   🗑️  源已删除，索引移除：projects/${o.name}`);
      }
    }
    if (!KEEP_ORPHANS) {
      console.log('   （备份在 .trash/ 下，已加入 .gitignore，不会上传；确认无用后 node sync.mjs --purge）');
    }
  }

  // ---------- 写盘 ----------
  if (DRY_RUN) {
    console.log('\n[dry-run] 未写入任何文件。');
    return;
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify(nextEntries, null, 2) + '\n', 'utf8');

  const nojekyll = path.join(ROOT, '.nojekyll');
  if (!fs.existsSync(nojekyll)) fs.writeFileSync(nojekyll, '', 'utf8');

  const gitignore = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, '.trash/\n', 'utf8');
  }

  console.log('');
  console.log(`✅ 完成：新增 ${copied} 个，更新 ${updated} 个，移除 ${orphans.length} 个，共 ${nextEntries.length} 个项目`);
  console.log(`   索引：projects.json`);
  console.log(`   提交：git add -A && git commit -m "sync projects" && git push`);
}

main();
