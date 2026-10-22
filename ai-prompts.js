// AI 提示词集中配置（2026-10-22）：全部 AI 生成提示词存 data/ai-prompts.json，
// 后台（/qianwanfuweng → AI 提示词页）可视可改，保存即生效、无需重启服务。
// 未保存过的字段自动回落到本文件的 DEFAULTS。
//
// 生成素材模板占位符：{topic}=用户描述  {styleSuffix}=所选风格描述
//                     {scienceRules}=科学约束  {cellColorRules}=微观配色（仅细胞类描述自动插入）
// 生成大图各类型 prompt 里的 {topic} 同理替换为用户描述。
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 科学约束（生成素材·通用）
  scienceRules: '严格遵循真实解剖学与形态学：结构与比例正确、位置关系正确，不省略关键鉴别特征，不添加不存在的结构；主体完整入镜不被裁切（含附肢、尾巴末端），经典侧面全身科学示意图视角，姿态自然；',
  // 微观配色（生成素材·仅细胞类描述自动追加）
  cellColorRules: '微观主体按教科书规范着色：细胞质浅黄或米色、细胞核蓝色、线粒体绿色、内质网紫色、高尔基体粉色，同类细胞器颜色保持统一；',
  // 细胞类关键词（正则，命中才追加 cellColorRules）
  cellularKeywords: '细胞|线粒体|内质网|高尔基|溶酶体|核糖体|中心体|伪足|吞噬泡|囊泡',
  // 生成素材总模板
  genTmpl: '{topic}，形态科学准确。{scienceRules}{cellColorRules}结构完整、细节到位：面部特征齐全（眼睛、鼻子、嘴巴都要清晰），动物主体必须画出胡须，四肢和脚趾分明；只画描述中提到的结构，不要擅自添加乳头、乳房等多余解剖结构。{styleSuffix}，轮廓圆润干净，类似 BioRender 的现代科研示意图，干净专业、辨识度高。颜色必须严格按描述：主体被毛/主体是什么颜色就是什么颜色——描述为黑色就是黑色、白色就是纯白（仅可配极轻阴影表现体积，整体观感必须仍是描述的颜色），严禁擅自更改主体颜色，不要发灰、不要偏米色；裸露的皮肤部位（尾巴、耳朵、口鼻、脚掌等）按真实生理结构呈肉粉色，不要画成被毛同色。透明背景，无任何文字和标注，主体板正居中，极简专业',
  // 生成素材三种风格描述
  styleSuffix: {
    flat: '二维扁平矢量插画风格，类似Adobe Illustrator绘制的科研示意图，色块平涂加柔和线性渐变，完全没有3D效果、没有写实感、没有光泽高光、没有阴影渲染。构图简洁克制、元素数量适中：只画描述中明确提到的结构，不要堆砌多余的细胞器、表面抗体或分子、装饰性元素',
    matte: '柔和的二维插画，色块内有细腻柔和的渐变晕染，质感像水彩和哑光奶油的结合，轻微柔和体积感；但绝对不要玻璃光泽、不要塑料感、不要强烈高光、不要3D渲染感、不要写实照片感',
    threed: '柔和的3D渲染插画：立体光影、柔和材质、类似Blender卡通渲染，圆润干净、轻微体积感，但绝对不要写实照片感、不要塑料感',
  },
  // 生成大图三种类型（prompt 模板 + 尺寸）
  big: {
    cover: {
      prompt: '{topic}。这是一幅学术期刊封面级插画（journal cover quality）：竖版构图，主体突出、视觉焦点集中，艺术表现力与科学内涵结合，配色专业和谐，可用柔和的渐变色背景烘托氛围，画面完整、细节丰富，不要出现任何文字或字母',
      size: '1728x2304',
    },
    abstract: {
      prompt: '{topic}。这是一幅论文摘要图（graphical abstract）：横向构图，研究核心逻辑一眼可懂，元素排布疏朗有层次，元素之间用箭头或流程关系连接，风格简洁专业，学术蓝绿色系配色和谐，不要出现任何文字或字母',
      size: '2560x1440',
    },
    mechanism: {
      prompt: '{topic}。这是一幅论文机制示意图（mechanism diagram）：科学逻辑准确，分子、细胞、组织等层级关系清晰，箭头与流程式布局，风格干净专业（类似 BioRender 机制图），配色低饱和和谐，结构边界清晰便于后续标注，不要出现任何文字或字母',
      size: '2304x1728',
    },
  },
  // 图层拆分默认指令（后台"AI 提示词"页可改）
  layerSplit: {
    instruction: '将图片进行精确图层分离，拆分为：主体元素、所有文字与标题、装饰元素、背景',
  },
  // 风格转换三种风格指令（qwen-image 图生图）
  stylize: {
    flat: '把这张图重绘成扁平矢量插画风格：色块平涂、柔和渐变、简洁流畅的轮廓线条，类似 Figdraw 科研示意图，保持原有构图和主体不变，纯色干净背景',
    matte: '把这张图重绘成柔和奶油质感插画：水彩般的渐变晕染、哑光柔和色彩、边缘圆润，保持原有构图和主体不变，纯色干净背景',
    threed: '把这张图重绘成 3D 渲染风格：立体光影、柔和材质、类似 Blender 卡通渲染，保持原有构图和主体不变，纯色干净背景',
  },
};

function deepMerge(base, over) {
  const out = Object.assign({}, base, over);
  for (const k of Object.keys(base)) {
    const b = base[k], o = (over || {})[k];
    if (b && typeof b === 'object' && !Array.isArray(b)) out[k] = Object.assign({}, b, o);
  }
  return out;
}

// DATA_DIR 为空 = 纯内存（测试/降级用），不落盘
module.exports = function makePromptStore(DATA_DIR) {
  const FILE = DATA_DIR ? path.join(DATA_DIR, 'ai-prompts.json') : null;

  function load() {
    let saved = {};
    if (FILE) { try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { saved = {}; } }
    const merged = deepMerge(DEFAULTS, saved);
    merged.styleSuffix = Object.assign({}, DEFAULTS.styleSuffix, saved.styleSuffix);
    merged.stylize = Object.assign({}, DEFAULTS.stylize, saved.stylize);
    merged.big = deepMerge(DEFAULTS.big, saved.big);
    return merged;
  }

  return {
    get: load,
    defaults: DEFAULTS,
    file: FILE,
    save(obj) {
      if (!FILE) throw new Error('提示词存储不可用（无数据目录）');
      if (!obj || typeof obj !== 'object') throw new Error('保存内容格式不对');
      const cur = load();
      const next = deepMerge(cur, obj);
      next.styleSuffix = Object.assign({}, cur.styleSuffix, obj.styleSuffix);
      next.stylize = Object.assign({}, cur.stylize, obj.stylize);
      next.big = deepMerge(cur.big, obj.big);
      const t = FILE + '.tmp';
      fs.writeFileSync(t, JSON.stringify(next, null, 1));
      fs.renameSync(t, FILE);
      return next;
    },
  };
};
