# OneFig 本地抠图/矢量化服务（bgserver.py 的 git 权威副本，部署到服务器 /opt/rembg-venv/bgserver.py）
# 2026-11-13 阶段1.1/1.2：CPU 密集处理从 async def（阻塞事件循环、全服务串行）
# 改为 run_in_threadpool 线程池执行 + anyio 信号量限并发（抠图 3、矢量化 2）。
# 2026-11-13 阶段2：新增 /matte-full —— 整条透明底流水线（rembg + 洪泛 + 选择性并集
# + 白边清理 + 质检）在本服务内用 numpy/scipy 一次性完成。Node 侧原 JS 实现
# （image-ops.js）保留为回退路径：服务不可用或端点不存在时 ai.js 自动降级，
# 行为与原实现逐像素对齐（port 自 ai.js image-ops.js / transparency.js，见各函数注释）。
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import Response
from fastapi.concurrency import run_in_threadpool
from rembg import remove, new_session
from PIL import Image
import io
import tempfile
import subprocess
import os
import threading
import vtracer
import numpy as np
from scipy import ndimage
from anyio import Semaphore
import time
import json
import base64

app = FastAPI()
# 2026-10-23：双模型，懒加载——启动不阻塞（模型文件大、下载慢），
# 首次调用时才加载；general=照片/通用，anime=插画/卡通/3D 渲染
# （ISNet-anime，对 AI 生成的科研插画分布更匹配，浅色主体误删更少）
_LAZY = {}
_LAZY_LOCK = threading.Lock()  # 2026-11-13：并发首调防重复下载/重复建会话
MODEL_NAMES = {"general": "isnet-general-use", "anime": "isnet-anime"}
# 2026-11-13 阶段2：onnxruntime 线程数收敛。默认每会话 intra_op=2：
# 单请求约 1.7s，3 路并发不再互相挤占 CPUQuota=300%（改造前 3 路并发单张恶化到 4.9s）。
# MATTE_INTRA_THREADS=1 更偏吞吐（3 路各 ~1 线程），=4 更偏单请求延迟。
_MATTE_INTRA_THREADS = int(os.environ.get("MATTE_INTRA_THREADS", "2"))
def get_session(name):
    key = MODEL_NAMES.get(name, name)
    with _LAZY_LOCK:
        if key not in _LAZY:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = _MATTE_INTRA_THREADS
            _LAZY[key] = new_session(key, sess_opts=opts)
    return _LAZY[key]
MAX_SIDE = 1024

# 2026-11-13 阶段1.2：并发护栏——抠图/matte 最多 2 路、矢量化最多 2 路。
# matte 2 路（而非 3）：双 ISNet 会话的 onnxruntime arena 随并发峰值膨胀且不回缩，
# 3 路并发曾把 RSS 推上 4.5G 触发 memory.high 回收抖动直至卡死（D 状态）。
# API 侧 LOCAL_BG_WORKERS=3 不变，多余请求在 API 队列等待。
matte_sem = Semaphore(2)
vec_sem = Semaphore(2)

@app.on_event("startup")
def _warm_sessions():
    """启动即加载双模型并做一次 64² 预测（2026-11-13 阶段2）：
    1) 首次请求不再承担模型加载延迟（曾导致 matte-full 首调 150s 超时）；
    2) RSS 在启动期确定，便于 systemd 内存护栏按稳态设置。"""
    from PIL import Image as _Img
    dummy = _Img.new("RGB", (64, 64), (250, 250, 252))
    b = io.BytesIO(); dummy.save(b, format="PNG")
    for m in ("general", "anime"):
        try:
            remove(b.getvalue(), session=get_session(m))
        except Exception:
            pass  # 启动不致命：首调时再懒加载

@app.get("/healthz")
def healthz():
    return {"ok": True}

# 浅色插画救援（2026-10-21）：ISNet 会把"白底浅色插画"的浅色主体（液泡/细胞质等）
# 误判成背景变成半透明幽灵。解法：模型 alpha 与"边缘洪泛亮色并集"取 max——
# 只在四角底色浅且均匀、洪泛确实抠掉一块时启用，其余情况完全信模型。
# 注意结果 RGB 必须用原图（模型输出在被删区域 RGB 是黑的，直接改 alpha 会露黑块）。
def hybrid_rescue(model_alpha: np.ndarray, rgb: np.ndarray) -> np.ndarray:
    # v2（2026-10-21）：底色固定按纯白洪泛（主体顶到四角、四角采样不干净时也能启用）；
    # 救援阈值 lum>140：捞回浅色细胞质（~210）和绿色叶绿体/棕色线粒体（~150-180），
    # 仍排除深色杂物（<120 的黑边/文字）。无白色背景时覆盖率≈0，自动不启用。
    h, w = model_alpha.shape
    bg = np.array([255.0, 255.0, 255.0])
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    near = dist < 38.0
    lab, _ = ndimage.label(near)
    seedlab = np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])
    edge_labels = np.unique(seedlab)
    edge_labels = edge_labels[edge_labels > 0]
    flood_bg = np.isin(lab, edge_labels)
    coverage = float(flood_bg.mean())
    if not (0.05 < coverage < 0.9):
        return model_alpha
    lum = rgb.mean(axis=2)
    rescue = np.where(flood_bg, 0, 255).astype(np.uint16)
    rescue = np.where(lum > 140, rescue, 0)
    return np.maximum(model_alpha.astype(np.uint16), rescue).astype(np.uint8)

# ==================== 阶段2：numpy 透明底流水线（port 自 Node image-ops.js / transparency.js） ====================
# 语义与 JS 实现逐像素对齐；唯一有意的差异是 JPEG 解码器（PIL vs jpeg-js），
# PNG 输入下两者结果一致。所有函数纯计算，可在线程池并发执行。

def _corner_mean6(rgb: np.ndarray):
    """四角 6x6 块均值（JS: corner(0,0); corner(w-6,0); corner(0,h-6); corner(w-6,h-6)）"""
    h, w, _ = rgb.shape
    blocks = [rgb[0:6, 0:6], rgb[0:6, w-6:w], rgb[h-6:h, 0:6], rgb[h-6:h, w-6:w]]
    return np.concatenate([b.reshape(-1, 3) for b in blocks]).mean(axis=0)  # [br,bg,bb]

def flood_matte_alpha(src: np.ndarray, luminance_tolerance: float):
    """洪泛抠底（port of image-ops.js floodMatte）：只删与边缘连通的背景色，
    返回 (alpha uint8 HxW, coverage)。覆盖率异常抛 ValueError（同 JS）。"""
    br, bg_, bb = _corner_mean6(src)
    corner_lum = (br + bg_ + bb) / 3.0
    lum = src.mean(axis=2)
    is_bg = np.abs(lum - corner_lum) < luminance_tolerance
    # 4 连通域；与四边连通的域即背景（JS 从四边洪泛，语义一致）
    lab, _ = ndimage.label(is_bg, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))
    border = np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])
    edge_labels = np.unique(border)
    edge_labels = edge_labels[edge_labels > 0]
    flood_bg = np.isin(lab, edge_labels)
    cov = float(flood_bg.mean())
    if not (0.03 < cov < 0.93):
        raise ValueError(f'flood coverage abnormal: {cov:.3f}')
    return np.where(flood_bg, 0, 255).astype(np.uint8), cov

def is_dark_subject(model_alpha: np.ndarray, src: np.ndarray) -> bool:
    """深色主体判定（port of image-ops.js isDarkSubject）"""
    mh, mw = model_alpha.shape
    sh, sw, _ = src.shape
    sub = model_alpha[::16, ::16]
    ys, xs = np.nonzero(sub > 128)
    if len(ys) == 0:
        return False
    sx = np.minimum(sw - 1, (xs * 16 * sw) // mw)
    sy = np.minimum(sh - 1, (ys * 16 * sh) // mh)
    lum = src[sy, sx].mean(axis=1)
    if len(lum) < 100:
        return False
    n = len(lum)
    # JS: 升序排序后取 luminance[floor(n/2)]（偶数长度取上中位），与 np.median 的均值法不同，必须对齐
    return float(np.partition(lum, n // 2)[n // 2]) < 150

def alpha_union(model_rgba: np.ndarray, flood_alpha: np.ndarray, src: np.ndarray,
                dark_subject: bool = False, detail_luminance: float = 180) -> np.ndarray:
    """选择性并集（port of image-ops.js alphaUnion）：模型负责主体；洪泛只补充
    与背景色反差明显的小碎片。返回 HxWx4 uint8（flood 尺寸 = 源图尺寸）。"""
    H, W = flood_alpha.shape
    mh, mw = model_rgba.shape[:2]
    # 模型最近邻上采样到 flood/源尺寸（JS: mx=floor(x*m.w/W), my=floor(y*m.h/H)）
    ix = np.minimum(mw - 1, (np.arange(W) * mw) // W)
    iy = np.minimum(mh - 1, (np.arange(H) * mh) // H)
    m_rgb = model_rgba[iy][:, ix][:, :, :3]
    m_a = model_rgba[iy][:, ix][:, :, 3]

    br, bg_, bb = _corner_mean6(src)
    s = src.astype(np.int32)
    dr = s[:, :, 0] - br; dg = s[:, :, 1] - bg_; db = s[:, :, 2] - bb
    span = s.max(axis=2) - s.min(axis=2)
    lum = s.mean(axis=2)
    yy = np.arange(H)[:, None]
    # 规则优先级与 JS 完全一致：darkFloor > (flood 高反差细节) > 深色下部低反差 > 模型
    dark_floor = dark_subject & (span < 18) & (lum > 130) & (yy > H * 0.55)
    strong = (span >= 30) | ((lum < detail_luminance) & (span < 6) & (dr * dr + dg * dg + db * db >= 42 * 42))
    flood_keep = (flood_alpha > 0) & strong
    dark_lower = dark_subject & (~strong) & (flood_alpha <= 24) & (yy > H * 0.55)

    use_model = ~(dark_floor | flood_keep | (dark_lower & ~flood_keep))
    model_keep = m_a > 24
    alpha = np.where(use_model & model_keep, m_a, np.where(use_model, 0, flood_alpha))
    rgb = np.where((use_model & model_keep)[..., None], m_rgb, src)
    out = np.dstack([rgb, alpha]).astype(np.uint8)
    return out

def _clamp_blur(alpha: np.ndarray, weights) -> np.ndarray:
    """可分离 3  tap 柔化 + 边缘 clamp（port of cleanEdge 的 sigma=0.35 高斯，边界语义=JS clamp）"""
    a = alpha.astype(np.float64)
    # 水平
    p = np.pad(a, ((0, 0), (1, 1)), mode='edge')
    t = p[:, :-2] * weights[0] + p[:, 1:-1] * weights[1] + p[:, 2:] * weights[2]
    # 垂直
    p = np.pad(t, ((1, 1), (0, 0)), mode='edge')
    b = p[:-2, :] * weights[0] + p[1:-1, :] * weights[1] + p[2:, :] * weights[2]
    return np.floor(b + 0.5).astype(np.uint8)  # Math.round 等价（half toward +inf）

def clean_edge(src: np.ndarray, matte_rgba: np.ndarray) -> np.ndarray:
    """白边清理（port of transparency.js cleanEdge）：只收缩近白色外缘、
    半透明像素白色去污染 + 轻微柔化；不整体缩边、不改变不透明主体。"""
    H, W = matte_rgba.shape[:2]
    raw = matte_rgba[:, :, 3]
    eroded = ndimage.minimum_filter(raw, size=3, mode='nearest')  # 3x3 最小值；min 幂等，边缘语义与 JS 一致
    s = src.astype(np.int32)
    near_white = ((s[:, :, 0] - 255) ** 2 + (s[:, :, 1] - 255) ** 2 + (s[:, :, 2] - 255) ** 2) < 70 * 70
    targeted = np.where(near_white & (eroded < raw), eroded, raw)
    sigma = 0.35
    side = np.exp(-0.5 / (sigma * sigma))
    sm = 1 + 2 * side
    blurred = _clamp_blur(targeted, [side / sm, 1 / sm, side / sm])
    a = blurred.astype(np.float64) / 255.0
    semi = (a > 0.02) & (a < 0.98)
    denom = np.maximum(a, 1e-4)
    recovered = (s - (1.0 - a)[..., None] * 255) / denom[..., None]
    recovered = np.where(semi[..., None], recovered, s)
    rgb = np.clip(np.floor(recovered + 0.5), 0, 255).astype(np.uint8)
    return np.dstack([rgb, blurred]).astype(np.uint8)

def inspect_transparency(rgba: np.ndarray, alpha_threshold=24, border_band_ratio=0.03,
                         max_border_opaque_ratio=0.005, max_opaque_ratio=0.90):
    """透明底质检（port of transparency.js inspectTransparency）"""
    h, w = rgba.shape[:2]
    band = max(1, min(min(w, h) // 2, int(np.floor(min(w, h) * border_band_ratio + 0.5))))  # JS Math.round 等价
    visible = rgba[:, :, 3] > alpha_threshold
    opaque_ratio = float(visible.mean())
    border = np.zeros((h, w), dtype=bool)
    border[:band, :] = border[-band:, :] = True
    border[:, :band] = border[:, -band:] = True
    bvis = visible[border]
    border_opaque_ratio = float(bvis.mean()) if bvis.size else 1.0
    reasons = []
    if int(visible.sum()) == 0:
        reasons.append('no-visible-subject')
    if opaque_ratio > max_opaque_ratio:
        reasons.append('background-almost-intact')
    if border_opaque_ratio > max_border_opaque_ratio:
        reasons.append('edge-background-residue')
    return {"ok": len(reasons) == 0, "reasons": reasons, "width": w, "height": h, "band": band,
            "opaqueRatio": opaque_ratio, "borderOpaqueRatio": border_opaque_ratio}

def _matte_impl(data: bytes, model: str, max_side: int):
    """整条透明底流水线（port of ai.js matteImage + removeBackgroundWithRetry 的单次尝试）：
    rembg(含 hybrid_rescue) → 洪泛(13，并行意义下先算) → 深色判定 → [洪泛(85)] →
    并集候选 + 模型候选 → cleanEdge + 质检选优。返回 (png_bytes, meta)。"""
    t0 = time.time()
    img = Image.open(io.BytesIO(data)).convert("RGB")
    if max(img.size) > max_side:
        scale = max_side / max(img.size)
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    src = np.array(img)
    buf = io.BytesIO(); img.save(buf, format="PNG")
    try:
        out = remove(buf.getvalue(), session=get_session(model if model in ("general", "anime") else "general"))
    except Exception:
        raise MatteModelUnavailable()  # 与 Node 侧语义一致：模型不可用禁止洪泛单路交付
    model_rgba = np.array(Image.open(io.BytesIO(out)).convert("RGBA"))
    if model_rgba.shape[0] != src.shape[0] or model_rgba.shape[1] != src.shape[1]:
        # 尺寸不一致时以模型尺寸为准重取源（防御，正常不会发生）
        src_img2 = Image.open(io.BytesIO(data)).convert("RGB").resize((model_rgba.shape[1], model_rgba.shape[0]), Image.LANCZOS)
        src = np.array(src_img2)
    model_rgba[:, :, 3] = hybrid_rescue(model_rgba[:, :, 3], src.astype(float))

    flood_alpha = None
    flood_err = None
    try:
        flood_alpha, _ = flood_matte_alpha(src, 13)
    except ValueError as e:
        flood_err = str(e)
    dark = is_dark_subject(model_rgba[:, :, 3], src)
    if dark:
        try:
            flood_alpha, _ = flood_matte_alpha(src, 85)
            flood_err = None
        except ValueError as e:
            flood_err = str(e)

    candidates = []
    if flood_alpha is not None:
        candidates.append((f"{model}-union", alpha_union(model_rgba, flood_alpha, src, dark)))
    candidates.append((model, model_rgba))
    attempts = []
    selected = None
    for name, cand in candidates:
        cleaned = clean_edge(src, cand)
        report = inspect_transparency(cleaned)
        attempts.append({"name": name, "report": report})
        if report["ok"]:
            selected = (name, cleaned)
            break
    if selected is None:
        selected = (candidates[0][0], clean_edge(src, candidates[0][1]))
    png = io.BytesIO(); Image.fromarray(selected[1]).save(png, format="PNG")
    meta = {"selected": selected[0], "darkSubject": dark, "floodErr": flood_err,
            "attempts": attempts, "ms": round((time.time() - t0) * 1000)}
    return png.getvalue(), meta

class MatteModelUnavailable(Exception):
    pass

@app.post("/matte-full")
async def matte_full(image: UploadFile = File(...), model: str = Form("anime"),
                     max_side: int = Form(1024)):
    """一次调用完成整条透明底流水线（2026-11-13 阶段2）。返回 PNG，
    元信息在 X-Matte-Meta 头（base64 JSON）。模型不可用时 503 + MATTE_MODEL_UNAVAILABLE。"""
    data = await image.read()
    async with matte_sem:
        try:
            png, meta = await run_in_threadpool(_matte_impl, data, model, max_side)
        except MatteModelUnavailable:
            raise HTTPException(status_code=503, detail="MATTE_MODEL_UNAVAILABLE")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)[:200])
    return Response(content=png, media_type="image/png",
                    headers={"X-Matte-Meta": base64.b64encode(json.dumps(meta).encode()).decode()})

# ==================== 阶段1：单功能端点（保持原行为） ====================

# 同步实现：抠图主体逻辑（原 remove_bg 函数体原样搬入，便于线程池执行）
def _remove_bg_impl(data: bytes, model: str) -> bytes:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    # 大图先缩小，控制内存和耗时
    if max(img.size) > MAX_SIDE:
        scale = MAX_SIDE / max(img.size)
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    out = remove(buf.getvalue(), session=get_session(model if model in ("general", "anime") else "general"))
    mo = Image.open(io.BytesIO(out)).convert("RGBA")
    final_alpha = hybrid_rescue(np.array(mo.getchannel("A")), np.array(img).astype(float))
    res = img.convert("RGBA")
    res.putalpha(Image.fromarray(final_alpha))
    obuf = io.BytesIO()
    res.save(obuf, format="PNG")
    return obuf.getvalue()

@app.post("/remove-bg")
async def remove_bg(image: UploadFile = File(...), model: str = Form("general")):
    # 2026-11-13 修复历史 Bug：此前 model: str = "general" 被 FastAPI 当查询参数，
    # 客户端提交的 model 字段被静默忽略——"anime" 自双模型上线以来从未生效（一直是 general）。
    # Form("general") 才是从 multipart 表单绑定。
    data = await image.read()
    # 线程池执行（不再阻塞事件循环）；信号量限制并发路数
    async with matte_sem:
        result = await run_in_threadpool(_remove_bg_impl, data, model)
    return Response(content=result, media_type="image/png")

VTRACER_BIN = "/opt/rembg-venv/vtracer-bin"

# 同步实现：矢量化主体逻辑（原 vectorize 函数体原样搬入）
def _vectorize_impl(data: bytes) -> bytes:
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    # 分辨率策略（2026-10-23）：官方 vtracer CLI 按原分辨率描摹（python 绑定内部
    # 会把输入压到长边 1024，细节损失大——这是此前效果差的第一因）。
    # 超大图（>2560）才缩小以控制耗时，不做放大（CLI 用真实像素，放大无意义）。
    MAX_SIDE_VEC = 2560
    if max(img.size) > MAX_SIDE_VEC:
        scale = MAX_SIDE_VEC / max(img.size)
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    tmp_in = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp_out = tempfile.NamedTemporaryFile(suffix=".svg", delete=False)
    try:
        img.save(tmp_in.name, format="PNG")
        tmp_in.close(); tmp_out.close()
        used_cli = False
        if os.path.exists(VTRACER_BIN):
            try:
                subprocess.run(
                    [VTRACER_BIN, tmp_in.name, tmp_out.name,
                     "--hierarchical", "cutout",   # 镂空层级：多色插画色块更干净
                     "--mode", "spline",         # 样条曲线
                     "--filter-speckle", "6",    # 滤碎斑
                     "--color-precision", "7"],  # 颜色聚类更准，减轻渐变色带
                    check=True, capture_output=True, timeout=110)
                used_cli = True
            except Exception:
                used_cli = False
        if not used_cli:
            # CLI 缺失/失败时回退 python 绑定（内部限 1024，效果降级但可用）
            vtracer.convert_image_to_svg_py(
                tmp_in.name, tmp_out.name,
                colormode="color", hierarchical="stacked", mode="spline",
                filter_speckle=4, color_precision=6, layer_difference=16,
                corner_threshold=60, length_threshold=4.0,
                splice_threshold=45, path_precision=3,
            )
        with open(tmp_out.name, "rb") as f:
            svg = f.read()
        return svg
    finally:
        for p in (tmp_in.name, tmp_out.name):
            try: os.unlink(p)
            except OSError: pass

@app.post("/vectorize")
async def vectorize(image: UploadFile = File(...)):
    data = await image.read()
    async with vec_sem:
        svg = await run_in_threadpool(_vectorize_impl, data)
    return Response(content=svg, media_type="image/svg+xml")
