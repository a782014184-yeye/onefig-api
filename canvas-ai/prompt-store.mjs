import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_GENERATION_PROMPT = `Based on the following content, generate a prompt for drawing schematic. The schematic illustration requirements are as follows: Vector illustration, Flat design, Hard edges, Color blocking, No gradients, No shading, No texture, Minimalist, High contrast. Biorender style. 

Use a clean white background, refined flat biomedical vector graphics, minimal text, and publication-quality visual hierarchy. The color palette should be soft pastel tones mint green, powder blue, blush pink, lavender, and pale peach.

单个元素不能太小，局部元素不要复杂、堆叠。
All labels must be in {{lang}}, Arial font, size 12, with precise alignment.`;

export const FLAT_DIAGRAM_GENERATION_PROMPT = `Create a publication-quality scientific mechanism illustration based exclusively on the scientific content below.

<scientific_content>
{{content}}
</scientific_content>

SCIENTIFIC ACCURACY
The source content is the sole scientific basis for the illustration. Accurately represent the described biological entities, cellular locations, molecular interactions, sequence of events, and causal directions. Do not invent pathways, molecules, receptors, organelles, experimental results, or relationships. Do not add plausible-looking details that are not supported by the source. If a detail is uncertain, use a simplified generic representation or omit it.

MECHANISM AND COMPOSITION
Make the mechanism immediately understandable, showing where each event occurs, its order, and its direction. Organize the illustration around one central mechanism with approximately 3–6 major steps or visual modules. Use a balanced landscape composition with generous white space and a clear left-to-right, top-to-bottom, or source-specified reading order.

Use simple arrows and connectors to indicate direction and interactions. Show activation, inhibition, transport, secretion, or binding only when supported by the source. Keep arrow styles consistent and avoid crossing connectors, tangled pathways, unnecessary repetition, and decorative elements that do not convey scientific information.

VISUAL STYLE
Create a professional BioRender-style biomedical illustration with a clean white background, flat vector graphics, minimalist geometry, crisp hard edges, solid color blocking, and clean medium-weight outlines.

Use soft pastel fills, primarily mint green, powder blue, blush pink, lavender, and pale peach. Use dark slate-gray outlines and text for strong readability and sufficient contrast. Maintain a polished, consistent, publication-quality visual hierarchy.

No gradients, shadows, shading, textures, transparency, highlights, glow, 3D rendering, photorealism, glossy surfaces, or painterly effects.

BIOLOGICAL ELEMENTS
Render cells, membranes, receptors, proteins, organelles, and other required entities as large, recognizable, simplified scientific icons. Preserve their essential biological morphology while reducing unnecessary internal detail. Keep each key element clearly separated and visually legible.

Avoid tiny molecules, intricate internal structures, excessive subunits, dense molecular clusters, crowded arrangements, and unnecessary overlapping. Do not place essential information in very small elements or fine lines.

SVG-FRIENDLY STRUCTURE
Design the artwork for clean raster-to-SVG conversion. Use simple closed shapes with smooth continuous contours, minimal overlap, uniform solid fills, and consistent medium-weight strokes. Limit the illustration to 5–7 flat fill colors, plus white and one dark outline color.

Keep adjacent color regions clearly separated and visually distinct. Avoid blurry edges, color bleeding, blend modes, hairline strokes, tiny gaps, intricate intersections, fragmented regions, and unnecessary small paths.

LABELS
Use only short labels necessary to understand the mechanism. All labels must be written in {{lang}} and use terminology consistent with the source content. Use Arial or a closely matching clean sans-serif font, with a consistent publication-label size and precise alignment.

Position every label close to its corresponding element without covering important structures. Ensure correct spelling and clear legibility. Do not generate long explanations, paragraphs, captions, figure titles, figure numbers, watermarks, random characters, or unnecessary legends.

FINAL RESULT
The result should look like a professionally designed scientific mechanism figure: scientifically faithful, visually simple, easy to follow, spacious, flat, clean, and suitable for later SVG conversion and editorial refinement.`;

export const FLAT_ABSTRACT_GENERATION_PROMPT = `Create a publication-quality scientific graphical abstract based exclusively on the research abstract or drawing instructions below.

<scientific_content>
{{content}}
</scientific_content>

PRIMARY OBJECTIVE
Summarize the study's core scientific message in one visually intuitive illustration. The viewer should quickly understand the research subject, the central process or intervention, and the main finding or conclusion. Prioritize the take-home message over comprehensive experimental detail.

SCIENTIFIC ACCURACY
Use only information explicitly supported by the source content. Accurately preserve scientific terminology, experimental relationships, directions of change, causal logic, and the distinction between methods, results, and conclusions.

Do not invent biological entities, mechanisms, experimental groups, numerical results, statistical significance, trends, or clinical implications. Do not turn correlations into causal relationships. If a detail is uncertain, simplify or omit it rather than guessing.

VISUAL STORY AND COMPOSITION
Build one clear visual narrative with a dominant central message. Organize the content into approximately 3–4 connected visual zones, such as:

research subject or problem → method, intervention, or central process → key result → main conclusion

Include only the zones supported by the source; do not force every zone into the figure. Use a balanced landscape composition with a clear left-to-right or top-to-bottom reading order, generous white space, and strong separation between sections.

Make the main finding the largest and most visually prominent part of the figure. Keep supporting methods and background information secondary. Use simple arrows to connect major stages, with consistent direction and no crossing connectors.

This is a graphical abstract, not a poster, presentation slide, dense flowchart, or comprehensive mechanism diagram. Avoid excessive panels, long workflows, detailed protocols, repetitive icons, and unnecessary decorative elements.

VISUAL STYLE
Use a professional BioRender-style biomedical vector aesthetic with a clean white background, flat design, minimalist geometry, crisp hard edges, solid color blocking, and clean medium-weight outlines.

Use soft pastel fills, primarily mint green, powder blue, blush pink, lavender, and pale peach. Use dark slate-gray outlines and label text for sufficient contrast. Maintain consistent visual language, spacing, alignment, and publication-quality hierarchy.

No gradients, shadows, shading, textures, transparency, highlights, glow, 3D rendering, photorealism, glossy surfaces, or painterly effects.

SCIENTIFIC ELEMENTS
Render biological, chemical, medical, or experimental elements as large, recognizable, simplified scientific icons. Preserve essential morphology and scientific identity while removing unnecessary internal detail.

Show experimental comparisons only when described in the source. Use clear visual differences between groups without exaggerating the reported effect. Do not create charts, graphs, numerical axes, or statistical symbols unless the source provides sufficient information to support them.

Avoid tiny elements, dense molecular structures, crowded clusters, excessive subunits, complex local arrangements, and unnecessary overlapping. Every important element must remain clearly visible at the final figure size.

SVG-FRIENDLY STRUCTURE
Design the artwork for clean raster-to-SVG conversion. Use simple closed shapes with smooth continuous contours, minimal overlap, uniform solid fills, and consistent medium-weight strokes.

Limit the illustration to 5–7 flat fill colors, plus white and one dark outline color. Keep adjacent color regions clearly separated and visually distinct. Avoid blurry edges, color bleeding, blend modes, hairline strokes, tiny gaps, intricate intersections, fragmented regions, and unnecessary small paths.

LABELS
Use only a small number of short labels necessary to understand the study's main message. All labels must be written in {{lang}} and use terminology consistent with the source content.

Use Arial or a closely matching clean sans-serif font, with consistent publication-label sizing and precise alignment. Position labels close to their corresponding elements without covering important structures. Ensure correct spelling and clear legibility.

Do not generate abstracts, paragraphs, captions, detailed annotations, reference citations, figure numbers, watermarks, random characters, or unnecessary legends. Do not add a title unless explicitly requested in the source instructions.

FINAL RESULT
The result should communicate the study's central contribution at a glance: scientifically faithful, visually focused, easy to follow, spacious, flat, clean, and suitable for journal submission, later SVG conversion, and editorial refinement.

Use a high-resolution 16:9 landscape canvas unless another aspect ratio is specified. Keep all essential elements fully inside the canvas with safe margins and no cropping.`;

function fillDiagramPrompt(template, content) {
  const text = String(content || '').trim();
  const lang = /[\u4e00-\u9fff]/.test(text) ? 'Chinese' : 'English';
  return template
    .replaceAll('{{content}}', text)
    .replaceAll('{{lang}}', lang);
}

export const buildFlatDiagramPrompt = content => fillDiagramPrompt(FLAT_DIAGRAM_GENERATION_PROMPT, content);
export const buildFlatAbstractPrompt = content => fillDiagramPrompt(FLAT_ABSTRACT_GENERATION_PROMPT, content);

const promptFile = root => path.join(root, 'data/admin/generation-prompt.txt');
const metaFile = root => path.join(root, 'data/admin/generation-prompt.json');

export function readGenerationPrompt(root) {
  try {
    const value = fs.readFileSync(promptFile(root), 'utf8').trim();
    if (value) return value;
  } catch { /* 首次使用默认值 */ }
  return DEFAULT_GENERATION_PROMPT;
}

export function registerPromptRoutes(app, root, consoleAuth) {
  fs.mkdirSync(path.dirname(promptFile(root)), { recursive: true });
  app.get('/api/admin/generation-prompt', consoleAuth, (_req, res) => {
    let updatedAt = null;
    try { updatedAt = fs.statSync(promptFile(root)).mtime.toISOString(); } catch { /* 尚未保存过 */ }
    res.json({ ok: true, prompt: readGenerationPrompt(root), defaultPrompt: DEFAULT_GENERATION_PROMPT, updatedAt });
  });
  app.put('/api/admin/generation-prompt', consoleAuth, (req, res) => {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: '提示词不能为空' });
    if (prompt.length > 20000) return res.status(400).json({ ok: false, error: '提示词不能超过 20000 个字符' });
    try {
      const file = promptFile(root);
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, prompt);
      fs.renameSync(temp, file);
      const updatedAt = new Date().toISOString();
      fs.writeFileSync(metaFile(root), JSON.stringify({ updatedAt }, null, 2));
      res.json({ ok: true, prompt, updatedAt });
    } catch {
      res.status(500).json({ ok: false, error: '提示词保存失败，请重试' });
    }
  });
}
