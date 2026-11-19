# OneFig 化学结构式服务端渲染服务（chem-render.py 的 git 权威副本）
# 部署：服务器 /opt/chem-venv/（pip install rdkit fastapi uvicorn），systemd 常驻 :8098
# 设计：
# - RDKit 完整版（非 wasm）原生支持 fixedFontSize / clearBackground / 显式氢——
#   浏览器端 rdkit-js 的所有限制在此不存在，前端那套 mask/让位/删虚线/锚点缩放
#   补偿机制全部不需要（RDKit 按最终字号自动重算键端缩短）
# - 布局缓存按 canon SMILES 存 molblock → 同一分子任意次渲染坐标逐字节一致
# - 输出仍经轻量后处理：键宽倍率 / mono 配色 / 内容裁剪 / 甲烷补 C
#   （与前端 name-to-structure.js 本地回退管线视觉对齐）
# - 前端 chem 组件「服务端优先，本地渲染回退」，本服务 502/不可达不影响功能
from fastapi import FastAPI
from pydantic import BaseModel
from rdkit import Chem, rdBase
from rdkit.Chem import rdDepictor
from rdkit.Chem.Draw import rdMolDraw2D
import hashlib
import math
import re
import threading

app = FastAPI()
_lock = threading.Lock()
_coord_cache = {}    # canon -> molblock（2D 坐标固定，保证布局确定性）
_svg_cache = {}      # (canon, bond, font, mode) -> svg
_F_cache = {}        # canon -> 1.0x 校准 fixedFontSize
_SVG_CACHE_MAX = 500

FONT_RATIO = 0.727   # cap-height / font-size（与前端校准一致）


class RenderReq(BaseModel):
    smiles: str
    molblock: str | None = None
    bondScale: float = 1.0
    fontScale: float = 1.0
    colorMode: str = "element"   # element | mono


def _canon(smiles: str) -> str | None:
    m = Chem.MolFromSmiles(smiles)
    return Chem.MolToSmiles(m) if m else None


def _mol_from(req: RenderReq):
    """模板分子（小分子/盐）用客户端来的 molblock（含显式氢与规范坐标）；
    其余分子按 canon 缓存坐标，保证布局确定性。"""
    if req.molblock:
        m = Chem.MolFromMolBlock(req.molblock, sanitize=False, removeHs=False)
        if m is not None:
            try:
                m.UpdatePropertyCache(strict=False)
            except Exception:
                pass
            return m
    canon = _canon(req.smiles)
    if not canon:
        return None
    src = hashlib.md5((req.smiles or "").encode()).hexdigest()[:12]
    with _lock:
        mb = _coord_cache.get(src)   # 坐标缓存按输入串：不同来源各自嵌入，互不串味
    if mb:
        return Chem.MolFromMolBlock(mb, sanitize=False, removeHs=False)
    m0 = Chem.MolFromSmiles(req.smiles)
    if m0 is None:
        return None
    rdDepictor.Compute2DCoords(m0)
    mb = Chem.MolToMolBlock(m0)
    with _lock:
        _coord_cache[src] = mb
    return m0


def _base_font_size(m, canon) -> float:
    """1.0x 档的 fixedFontSize：先默认排版，量最大标签字形高，按 FONT_RATIO 换算。"""
    with _lock:
        f = _F_cache.get(canon)
    if f:
        return f
    d = rdMolDraw2D.MolDraw2DSVG(420, 320)
    d.drawOptions().clearBackground = False
    rdMolDraw2D.PrepareAndDrawMolecule(d, m)
    d.FinishDrawing()
    h_max = 0.0
    for mm in re.finditer(r"<path class='atom-[^']*' d='([^']+)'", d.GetDrawingText()):
        nums = [float(x) for x in re.findall(r"-?\d+\.?\d*", mm.group(1))]
        ys = nums[1::2]
        if ys:
            h_max = max(h_max, max(ys) - min(ys))
    f = (h_max / FONT_RATIO) if h_max > 0 else 0.0
    if f > 0:
        with _lock:
            _F_cache[canon] = f
    return f


def _draw(m, canon, fontScale: float) -> str:
    d = rdMolDraw2D.MolDraw2DSVG(420, 320)
    opts = d.drawOptions()
    opts.clearBackground = False          # 透明底（画布集成要求）
    opts.singleColourBonds = True         # 键整体纯黑，不做按原子分色（§4 渲染规范）
    if abs(fontScale - 1.0) > 1e-6:
        base = _base_font_size(m, canon)
        if base > 0:
            opts.fixedFontSize = int(max(4.0, round(base * fontScale)))
    rdMolDraw2D.PrepareAndDrawMolecule(d, m)
    d.FinishDrawing()
    return d.GetDrawingText()


# ---------- 轻量后处理（与前端本地管线视觉对齐） ----------

def _post(svg: str, bondScale: float, colorMode: str, center_carbon: bool) -> str:
    # 线宽倍率
    if abs(bondScale - 1.0) > 1e-6:
        svg = re.sub(
            r"stroke-width:([\d.]+)px",
            lambda m: "stroke-width:%.2fpx" % (float(m.group(1)) * bondScale),
            svg,
        )
    # mono：非白填充一律转黑——RDKit 两种写法都处理：style 里的 fill:#XXX 和
    # 属性里的 fill='#XXX'（v47 报告：属性写法漏网，mono 下标签仍红）
    if colorMode == "mono":
        svg = re.sub(r"fill:(?!#FFF|#fff)('?#[0-9A-Fa-f]{6}'?)",
                     lambda m: "fill:#000000" if "'" not in m.group(1) else "fill:'#000000'", svg)
        svg = re.sub(r"fill=(['\"])(?!#FFF|#fff)#[0-9A-Fa-f]{6}\1", r"fill=\1#000000\1", svg)
    # 内容裁剪 + 视图重设
    svg = _crop(svg)
    # 甲烷补 C
    if center_carbon:
        svg = _inject_carbon(svg)
        svg = _crop(svg)
    return svg


def _crop(svg: str) -> str:
    minx = miny = float("inf")
    maxx = maxy = float("-inf")

    def eat(x, y):
        nonlocal minx, miny, maxx, maxy
        minx = min(minx, x); maxx = max(maxx, x)
        miny = min(miny, y); maxy = max(maxy, y)

    for mm in re.finditer(r"<path[^>]*d='([^']+)'", svg):
        nums = [float(x) for x in re.findall(r"-?\d+\.?\d*", mm.group(1))]
        for i in range(0, len(nums) - 1, 2):
            eat(nums[i], nums[i + 1])
    def _g(tag, a):
        m2 = re.search(a + r"='([\d.-]+)'", tag)
        return float(m2.group(1)) if m2 else None
    for mm in re.finditer(r"<line\b[^>]*>", svg):
        tag = mm.group(0)
        x1, y1, x2, y2 = _g(tag, "x1"), _g(tag, "y1"), _g(tag, "x2"), _g(tag, "y2")
        if x1 is not None and y1 is not None:
            eat(x1, y1)
            eat(x2, y2)
    for mm in re.finditer(r"<(circle|ellipse)\b[^>]*>", svg):
        tag = mm.group(0)
        cx, cy = _g(tag, "cx") or 0.0, _g(tag, "cy") or 0.0
        rx = _g(tag, "r") or _g(tag, "rx") or 0.0
        ry = _g(tag, "r") or _g(tag, "ry") or 0.0
        eat(cx - rx, cy - ry)
        eat(cx + rx, cy + ry)
    for mm in re.finditer(r"<text\b[^>]*>", svg):
        tag = mm.group(0)
        fx = re.search(r"x='([\d.-]+)'", tag)
        fy = re.search(r"y='([\d.-]+)'", tag)
        fs = re.search(r"font-size='([\d.]+)'", tag) or re.search(r"font-size='([\d.]+)px'", tag)
        half = float(fs.group(1)) * 0.45 if fs else 10.0
        tx = float(fx.group(1)) if fx else 0.0
        ty = float(fy.group(1)) if fy else 0.0
        eat(tx - half, ty - half)
        eat(tx + half, ty + half)

    if not math.isfinite(minx):
        return svg
    pad = 6.0
    minx -= pad; miny -= pad; maxx += pad; maxy += pad
    w = maxx - minx
    h = maxy - miny

    def repl(m):
        tag = m.group(0)
        tag = re.sub(r"width='[^']*'", "width='%.0fpx'" % w, tag, count=1)
        tag = re.sub(r"height='[^']*'", "height='%.0fpx'" % h, tag, count=1)
        tag = re.sub(r"viewBox='[^']*'", "viewBox='%.1f %.1f %.1f %.1f'" % (minx, miny, w, h), tag, count=1)
        return tag

    return re.sub(r"<svg\b[^>]*>", repl, svg, count=1)


def _inject_carbon(svg: str) -> str:
    """甲烷：中心碳无字形（RDKit 骨架约定），补 C 并把四根键端缩到字边。"""
    ends = []
    for mm in re.finditer(r"<line class='bond-[^']*'[^>]*>", svg):
        tag = mm.group(0)
        g = lambda a: float(re.search(a + r"='([\d.-]+)'", tag).group(1))
        ends.append((g("x1"), g("y1"))); ends.append((g("x2"), g("y2")))
    for mm in re.finditer(r"<path class='bond-[^']*' d='([^']+)'", svg):
        nums = [float(x) for x in re.findall(r"-?\d+\.?\d*", mm.group(1))]
        if len(nums) >= 4:
            ends.append((nums[0], nums[1])); ends.append((nums[-2], nums[-1]))
    if not ends:
        return svg
    best = None
    for e in ends:
        cluster = [o for o in ends if math.hypot(o[0] - e[0], o[1] - e[1]) <= 3]
        if best is None or len(cluster) > best[0]:
            cx = sum(o[0] for o in cluster) / len(cluster)
            cy = sum(o[1] for o in cluster) / len(cluster)
            best = (len(cluster), cx, cy)
    _, cx, cy = best
    # 字号跟随 H 字形高
    h_max = 0.0
    for mm in re.finditer(r"<path class='atom-[^']*' d='([^']+)'", svg):
        nums = [float(x) for x in re.findall(r"-?\d+\.?\d*", mm.group(1))]
        ys = nums[1::2]
        if ys:
            h_max = max(h_max, max(ys) - min(ys))
    if h_max <= 0:
        return svg
    fs = h_max / FONT_RATIO
    half_x, half_y = fs * 0.42, fs * 0.5
    box = (cx - half_x, cy - half_y, cx + half_x, cy + half_y)

    def pull(px, py, ox, oy):
        if not (box[0] <= px <= box[2] and box[1] <= py <= box[3]):
            return None
        dx, dy = px - ox, py - oy
        L = math.hypot(dx, dy)
        if L < 1e-6:
            return None
        ux, uy = dx / L, dy / L
        t_in, t_out = -float("inf"), float("inf")
        if ux > 1e-9:
            t_in = max(t_in, (box[0] - ox) / ux); t_out = min(t_out, (box[2] - ox) / ux)
        elif ux < -1e-9:
            t_in = max(t_in, (box[2] - ox) / ux); t_out = min(t_out, (box[0] - ox) / ux)
        if uy > 1e-9:
            t_in = max(t_in, (box[1] - oy) / uy); t_out = min(t_out, (box[3] - oy) / uy)
        elif uy < -1e-9:
            t_in = max(t_in, (box[3] - oy) / uy); t_out = min(t_out, (box[1] - oy) / uy)
        if t_in > t_out or t_in < 0 or t_in > L:
            return None
        return (ox + ux * t_in, oy + uy * t_in)

    # 缩 line
    def fix_line(m):
        tag = m.group(0)
        g = lambda a: float(re.search(a + r"='([\d.-]+)'", tag).group(1))
        p1 = (g("x1"), g("y1")); p2 = (g("x2"), g("y2"))
        n1 = pull(p1[0], p1[1], p2[0], p2[1]) or p1
        n2 = pull(p2[0], p2[1], p1[0], p1[1]) or p2
        tag = re.sub(r"x1='[^']*'", "x1='%.2f'" % n1[0], tag)
        tag = re.sub(r"y1='[^']*'", "y1='%.2f'" % n1[1], tag)
        tag = re.sub(r"x2='[^']*'", "x2='%.2f'" % n2[0], tag)
        tag = re.sub(r"y2='[^']*'", "y2='%.2f'" % n2[1], tag)
        return tag
    svg = re.sub(r"<line class='bond-[^']*'[^>]*/>", fix_line, svg)

    # 缩 path 键（只动首尾坐标对）
    def fix_path(m):
        head = m.group(1)
        d = m.group(2)
        nums = [float(x) for x in re.findall(r"-?\d+\.?\d*", d)]
        if len(nums) < 4:
            return m.group(0)
        p1 = (nums[0], nums[1]); p2 = (nums[-2], nums[-1])
        n1 = pull(p1[0], p1[1], p2[0], p2[1]) or p1
        n2 = pull(p2[0], p2[1], p1[0], p1[1]) or p2
        vals = list(nums)
        vals[0], vals[1] = n1
        vals[-2], vals[-1] = n2
        it = iter(["%.2f" % v for v in vals])
        nd = re.sub(r"-?\d+\.?\d*", lambda _x: next(it), d)
        return head + nd + "'"
    svg = re.sub(r"(<path class='bond-[^']*' d=')([^']+)(')", fix_path, svg)

    # stroke 加粗描边：RDKit 标签是实心粗字形，纯 text 字重偏细（v47 报告）
    sw = fs * 0.01
    text = ("<text x='%.2f' y='%.2f' text-anchor='middle' dominant-baseline='central' "
            "font-family='Arial, Helvetica, sans-serif' font-weight='normal' font-size='%.1f' "
            "stroke='#000000' stroke-width='%.2f' paint-order='stroke fill' "
            "fill='#000000' class='atom-carbon'>C</text>") % (cx, cy, fs, sw)
    return svg.replace("</svg>", text + "</svg>")


@app.get("/health")
def health():
    return {"ok": True, "rdkit": rdBase.rdkitVersion}


@app.post("/render")
def render(req: RenderReq):
    m = _mol_from(req)
    if m is None:
        return {"ok": False, "error": "smiles parse failed"}
    canon = _canon(req.smiles) or req.smiles
    # 缓存键必须区分输入来源：同分异构体不同输入串的 2D 嵌入朝向不同
    # （vd3 案例：wasm 规范串嵌入朝向差，C17 虚楔与环键重叠且 H 失标；v54 报告）
    src = hashlib.md5((req.smiles or "").encode()).hexdigest()[:12]
    kind = "mb" if req.molblock else "smi"
    key = (canon, round(req.bondScale, 2), round(req.fontScale, 2), req.colorMode, kind, src)
    with _lock:
        cached = _svg_cache.get(key)
    if cached:
        return {"ok": True, "svg": cached, "server": True}
    try:
        svg = _draw(m, canon, req.fontScale)
        svg = _post(svg, req.bondScale, req.colorMode, center_carbon=(canon == "C"))
    except Exception as e:   # 渲染失败让前端回退本地管线
        return {"ok": False, "error": str(e)[:200]}
    with _lock:
        if len(_svg_cache) > _SVG_CACHE_MAX:
            _svg_cache.clear()
        _svg_cache[key] = svg
    return {"ok": True, "svg": svg, "server": True}
