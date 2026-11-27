export const COVER_BASE_PROMPT = `OPENING
Create a publication-quality scientific journal cover illustration based exclusively on the research abstract or drawing instructions below.

SOURCE
<scientific_content>
{{content}}
</scientific_content>

CORE OBJECTIVE
Transform the study's central scientific finding into one striking, memorable, and visually coherent cover image. Prioritize a powerful central concept, artistic quality, and immediate visual impact over exhaustive experimental detail.

SCIENTIFIC ACCURACY
Preserve the essential identity, morphology, scale relationships, interactions, and scientific meaning of the main subject. Do not invent unsupported mechanisms, structures, experimental results, causal relationships, or clinical implications. Artistic abstraction and visual metaphor are encouraged, but they must remain faithful to the study's central conclusion. Speculative relationships must not be presented as established facts.

COVER COMPOSITION
Create one dominant scientific hero subject with a strong focal point and a clear visual hierarchy. Use intentional asymmetry, dramatic scale, controlled negative space, and a strong silhouette to create a distinctive journal-cover composition.

The image should look like a finished work of scientific cover art, not an infographic, mechanism diagram, presentation slide, poster, or multi-panel figure. Avoid repetitive icons, dense flowcharts, excessive arrows, long labels, and unnecessary decorative elements.

Leave deliberate negative space for potential journal typography without making the composition feel empty or unfinished. Keep all essential subjects fully inside the canvas with safe margins.

TEXT AND OUTPUT
Generate no text, title, caption, logo, watermark, border, figure number, or decorative typography unless explicitly requested in the source instructions.

Use a high-resolution portrait canvas, preferably 3:4 unless another aspect ratio is specified. Apply the selected artistic style below while keeping the scientific subject recognizable.`;

export const COVER_STYLE_PROMPTS = {
  flat: `STYLE: FLAT COLOR-BLOCK VECTOR ART WITH ONE UNIFORM INK LINE
Think of this image as a finished file exported from Adobe Illustrator: every shape is a closed path, filled with one flat color, and stroked with one pen. The single most important quality is that the linework looks machine-drawn — the same ink, the same width, the same full opacity on every single path in the image. It is flat scientific editorial illustration, not luminous digital painting, semi-realistic rendering, or 3D art.

INK LINE STANDARD (HIGHEST PRIORITY — APPLY BEFORE ANY OTHER RULE)
Use exactly one outline ink for the entire illustration: a near-black desaturated plum, approximately #241B2E, at 100% opacity.
- Never tint the outline to match the shape it encloses. A pale blue cell, a mint shape, a coral cell, a lavender granule, and a warm gold antigen all receive the identical ink. Do not use blue, red, mint, or lavender outlines anywhere.
- Never lighten, soften, fade, or thin the ink anywhere. No gradient along a stroke, no transparent ends, no lighter stroke over dark fills, no pale outline where two pale fills meet.
- Use one constant stroke width for every path in the image — cell membrane, nuclear envelope, organelle, receptor, granule, dot. No thick hero outlines and no hairline details. No line-weight hierarchy, no taper, no calligraphic thick-thin, no pressure variation, no swelling at curves.
- The width should read as fine, even technical linework: about 0.4% of the image width (roughly 5 px on a 1200 px canvas), with round joins and round caps.
- Every stroke must be a complete, continuous, closed path. No gaps, no fading-out, no broken or intermittent segments, no stray stubs, no double stroke, no offset drop-shadow line, no dashed or dotted lines, no hand-sketched wobble.
- If an element is too small to hold that line width legibly, simplify or enlarge the element — never thin or drop its outline.
- Outlines sit crisply on top of their fills: hard edges, no soft airbrushed rim, no halo, no blur, no bloom.

COLOR BLOCKS
Fill every shape with flat, 100% opaque, uniform color. Controlled palette: deep navy, dark teal, mint green, powder blue, coral red, warm gold, lavender, off-white. Use flat tonal variants of the same hue to build depth, but each variant must be its own closed shape with its own ink line. No semi-transparent overlay patches, no see-through layers, no gradient, no glow, no volumetric light, no glossy highlights, no bevel, no 3D shading, no painterly blending, no grain, no paper texture, no speckle.

DETAIL LEVEL
Express internal structure as small closed outlined shapes — folded membrane, stacked cisternae, cristae, packed granules, receptor subunits — not as open flowing contour lines or scratchy hatching. Use a few well-designed structural details instead of dense filigree. Keep every detail readable at a glance; no fine hair-like tangles, no random particles, no decorative molecular clutter.

COVER COMPOSITION
Create a strong diagonal, spiral, radial, or sweeping curved composition appropriate to the supplied scientific content. Establish one dominant hero subject and a clear interaction or transformation. Use foreground, middle-ground, and background overlap to create a sophisticated editorial composition. Include only a few supporting silhouettes in the background. Reserve clean negative space near the top for later journal typography. Keep essential subjects inside the canvas.

ARTISTIC STANDARD
The result should combine BioRender-like scientific clarity with the composition of a professionally art-directed journal cover, executed like a polished flat vector poster made of filled paths and uniform ink strokes. Avoid childish cartoons, sticker art, thick comic-book outlines, PowerPoint icons, simple geometric clip art, excessive white circular frames, and large instructional arrows. The image must remain visibly flat, evenly outlined, and color-block driven even at first glance.`,
  threed: `STYLE: CINEMATIC 3D SCIENTIFIC ART
Create a premium three-dimensional scientific cover with convincing depth, carefully modeled forms, physically plausible materials, and cinematic studio lighting. Give the central subject a sculptural presence with realistic volume, subtle surface detail, and controlled depth of field.

Use materials appropriate to the scientific subject, such as soft biological membranes, translucent cellular layers, crystalline structures, ceramics, or engineered surfaces. Maintain the essential morphology and structural relationships of the subject.

Use a restrained, sophisticated color palette and a clean background with atmospheric depth. Avoid excessive metallic or glass materials, plastic-like surfaces, aggressive reflections, blue neon clichés, extreme lens blur, visual clutter, and unsupported microscopic details.`,
  matte: `STYLE: SOFT HAND-DRAWN SCIENTIFIC ILLUSTRATION
Create a refined editorial scientific illustration with delicate hand-drawn linework, gentle organic contours, muted colored-pencil or gouache-like fills, and subtle natural variations in line weight. Preserve accurate scientific proportions while allowing a warm, tactile, human-made appearance.

Use soft lighting, harmonious colors, elegant imperfections, and a lightly textured paper surface. The main subject should be rendered with greater precision than the surrounding environment, maintaining a clear scientific focal point.

Avoid childlike picture-book aesthetics, exaggerated cuteness, cartoon facial expressions, loose anatomical errors, messy sketch lines, and excessive paper texture. The result should feel sophisticated, calm, and suitable for an academic journal cover.`,
  ink: `STYLE: CONTEMPORARY CHINESE INK-WASH SCIENTIFIC ART
Create a contemporary Chinese ink-wash scientific cover that integrates the main research subject with expressive brushwork, layered ink dilutions, and meaningful negative space. Use a harmonious balance between precise scientific representation and poetic visual abstraction.

Render the central subject with enough structural clarity to remain scientifically recognizable. Use black and gray ink as the visual foundation, with restrained mineral-color accents such as mineral green, indigo, cinnabar, or muted ochre where appropriate. Include subtle rice-paper texture and controlled ink diffusion.

Use empty space as an active compositional element. Avoid generic landscape painting, excessive splashes, uncontrolled bleeding, muddy contours, decorative dragons, calligraphy, poetry, seals, and traditional cultural symbols unrelated to the research.`,
  oil: `STYLE: CONTEMPORARY WESTERN OIL-PAINTED SCIENTIFIC ART
Create a museum-quality scientific cover in the visual language of a contemporary Western oil painting. Use rich but controlled pigments, expressive yet deliberate brushwork, subtle canvas texture, dramatic chiaroscuro, and a strong sense of visual narrative.

Give the central scientific subject a clear silhouette and greater detail than the background. Use layered paint and selective impasto to emphasize important forms while preserving the subject's essential structure and relationships.

Favor a sophisticated editorial composition over a historical scene. Avoid muddy colors, uniformly heavy brushwork, excessive impasto, classical portraits, religious imagery, decorative still-life arrangements, and dramatic effects that obscure the scientific subject.`,
  watercolor: `STYLE: MODERN SCIENTIFIC WATERCOLOR
Create an elegant scientific journal cover using modern watercolor illustration. Combine translucent color washes, delicate pigment granulation, controlled wet-on-wet transitions, and finer wet-on-dry details on the central scientific subject.

Use a harmonious palette with clean highlights, fresh whites, soft color layering, and a clear focal point. Keep the primary subject more sharply defined than the background so that its scientific identity remains recognizable. Use subtle pigment blooms and watermarks to create atmosphere without overwhelming the composition.

The paper texture should be fine and restrained. Avoid washed-out low-contrast subjects, uncontrolled color bleeding, muddy overlaps, excessive splatters, decorative flowers unrelated to the research, sketchbook layouts, handwritten notes, and overly sentimental storybook aesthetics.`,
  surreal: `STYLE: SCIENTIFICALLY GROUNDED SURREALISM
Create a sophisticated surreal scientific cover built around one coherent visual metaphor derived from the study's main finding. Combine scientific subjects with unexpected scale relationships, symbolic transformations, impossible architectures, dreamlike environments, or poetic juxtapositions.

The central scientific entity must remain recognizable and structurally credible, even when integrated into an impossible scene. Every major symbolic element should support the same conceptual message. Use a strong focal point, cinematic spatial depth, controlled lighting, and a refined contemporary art aesthetic.

Balance conceptual boldness with visual clarity. Avoid random dream imagery, unrelated symbolic objects, generic melting forms, incoherent floating elements, horror imagery, excessive visual clutter, and surreal transformations that misrepresent the study's conclusions. The result should feel intellectually intriguing rather than arbitrary or chaotic.`,
  papercut: `STYLE: LAYERED PAPER-CUT SCIENTIFIC COVER ART
Create a sophisticated scientific journal cover using layered paper-cut and paper-sculpture illustration. Construct the entire scene from carefully cut paper layers with crisp, continuous edges, solid colors, and clearly visible physical depth.

VISUAL CONSTRUCTION
Translate the main scientific subject into bold, recognizable paper silhouettes. Use separate cut-paper layers to represent meaningful structures such as cell membranes, organelles, molecular complexes, tissue regions, vessels, or ecological layers. Create depth through overlapping sheets, stepped layers, controlled cutouts, and subtle contact shadows between paper surfaces. The layering must express real scientific relationships rather than serve as arbitrary decoration. Use one dominant central paper-cut subject with a strong silhouette and dramatic scale. Guide the viewer through the scientific story using layered openings, curved paper channels, and spatial relationships rather than dense arrows or panels.

COLOR AND MATERIAL
Use a curated palette of 5–7 coordinated paper colors, combining deep teal, navy, or burgundy with selected accents such as mint, coral, warm gold, lavender, powder blue, and off-white. Keep each paper layer uniformly colored. Use subtle paper grain only at close inspection and restrained contact shadows to separate layers. Do not use glossy materials, metallic surfaces, glass, volumetric lighting, or photorealistic 3D rendering.

DETAIL AND COMPOSITION
Include enough precision to preserve the scientific identity of the main subject. Use clean, deliberate cutouts and elegant internal shapes. Avoid excessive micro-cuts, shredded edges, fragmented contours, dense filigree, random decorative holes, and unnecessary confetti-like particles. The result should look like a professionally art-directed editorial paper sculpture, not a children's craft project, greeting card, scrapbook, or handmade classroom model.

OUTPUT
Use a high-resolution 3:4 portrait composition with intentional negative space for later journal typography. Keep all essential subjects inside the canvas. Generate no text, labels, captions, logos, watermarks, or decorative typography.`,
};

export function buildCoverGenerationPrompt(content, style = 'flat') {
  const module = COVER_STYLE_PROMPTS[style] || COVER_STYLE_PROMPTS.flat;
  return `${COVER_BASE_PROMPT.replaceAll('{{content}}', String(content || '').trim())}\n\n${module}`;
}
