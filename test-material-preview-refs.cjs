const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateMaterialPreviewRefs } = require('./migrate-material-preview-refs.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onefig-preview-ref-test-'));
const dataDir = path.join(root, 'data');
const webRoot = path.join(root, 'web');
const boardDir = path.join(dataDir, 'boards', 'dummy-user');
fs.mkdirSync(path.join(dataDir, 'console'), { recursive: true });
fs.mkdirSync(boardDir, { recursive: true });
fs.mkdirSync(path.join(webRoot, 'previews', '测试系列'), { recursive: true });
fs.writeFileSync(path.join(webRoot, 'previews', '测试系列', '素材A.webp'), 'dummy-webp');
fs.writeFileSync(path.join(dataDir, 'console', 'materials.json'), JSON.stringify([
  { folder: '测试系列', materials: [
    { title: '素材A', file: '素材A.png', local: true },
    { title: '缺预览', file: '缺预览.png', local: true },
  ] },
  { folder: 'Fig', materials: [{ title: '内部', file: 'fig-1700000000000-abcdef01.svg', local: true }] },
]));
const boardFile = path.join(boardDir, 'board.json');
const original = {
  elements: [
    { src: '/files/测试系列/素材A.png' },
    { librarySrc: '/files/%E6%B5%8B%E8%AF%95%E7%B3%BB%E5%88%97/%E7%B4%A0%E6%9D%90A.png' },
    { colorOriginalSrc: '/files/测试系列/缺预览.png' },
    { src: '/files/Fig/fig-1700000000000-abcdef01.svg' },
    { src: '/files/ai-out-test.png' },
  ],
};
fs.writeFileSync(boardFile, JSON.stringify(original, null, 2));

try {
  const before = fs.readFileSync(boardFile, 'utf8');
  const dry = migrateMaterialPreviewRefs({ dataDir, webRoot });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.refsChanged, 2);
  assert.equal(dry.boardFilesChanged, 0);
  assert.equal(dry.missingPreviews.length, 1);
  assert.equal(fs.readFileSync(boardFile, 'utf8'), before, 'dry-run 不得写入');

  const applied = migrateMaterialPreviewRefs({ dataDir, webRoot, apply: true });
  assert.equal(applied.refsChanged, 2);
  assert.equal(applied.boardFilesChanged, 1);
  const data = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  assert.equal(data.elements[0].src, '/previews/测试系列/素材A.webp');
  assert.equal(data.elements[1].librarySrc, '/previews/%E6%B5%8B%E8%AF%95%E7%B3%BB%E5%88%97/%E7%B4%A0%E6%9D%90A.webp');
  assert.equal(data.elements[2].colorOriginalSrc, '/files/测试系列/缺预览.png', '缺预览时必须保留并报告');
  assert.equal(data.elements[3].src, original.elements[3].src, 'Fig 不得改为公开预览');
  assert.equal(data.elements[4].src, original.elements[4].src, 'AI 文件不受影响');
  assert.ok(applied.backupRoot && fs.existsSync(path.join(applied.backupRoot, 'dummy-user', 'board.json')), 'apply 前必须备份');

  const again = migrateMaterialPreviewRefs({ dataDir, webRoot, apply: true });
  assert.equal(again.refsChanged, 0, '重复执行必须幂等');
  console.log('✓ dry-run 只读、编码路径迁移、缺预览保护、Fig/AI 排除、备份与幂等均通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
