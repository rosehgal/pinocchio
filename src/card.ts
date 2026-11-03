// Share card: satori lays out the HTML-ish tree as SVG, resvg rasterizes it. Fully local.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

export interface CardData {
  headline: string; // the claim in quotes, or the clean-record line
  verdict: string; // e.g. "said 40s after `pytest -q` failed"
  meta: string; // when, harness, project
  stats: string; // one line of totals
  nose: number; // cm
  tone: 'red' | 'amber' | 'green';
}

const require = createRequire(import.meta.url);
const font = (pkg: string, weight: 400 | 800, name: string) => ({
  name,
  weight,
  style: 'normal' as const,
  data: readFileSync(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-${weight}-normal.woff`)),
});

const div = (style: Record<string, unknown>, ...children: unknown[]) => ({
  type: 'div',
  props: { style: { display: 'flex', ...style }, children },
});

const INK = '#2b1d12', WOOD = '#a0652f', PAPER = '#fbf3e4';
const TONE = { red: '#d7263d', amber: '#c77d0a', green: '#2f8f4e' };

export async function renderCard(d: CardData): Promise<Buffer> {
  const headline = d.headline.length > 140 ? d.headline.slice(0, 139) + '…' : d.headline;
  const size = headline.length < 45 ? 68 : headline.length < 90 ? 52 : 40;
  const nosePx = Math.round(Math.min(760, 40 + d.nose * 24));
  const tree = div(
    { width: 1200, height: 675, boxSizing: 'border-box', flexDirection: 'column', justifyContent: 'space-between', padding: '56px 64px', background: PAPER, color: INK, fontFamily: 'Inter' },
    div(
      { alignItems: 'center', justifyContent: 'space-between' },
      div({ fontSize: 26, fontWeight: 800, letterSpacing: 6, color: WOOD }, 'PINOCCHIO'),
      div({ fontSize: 26, fontFamily: 'Mono', color: TONE[d.tone] }, `nose: ${d.nose} cm`),
    ),
    div(
      { alignItems: 'center' },
      div({ width: 64, height: 64, borderRadius: 32, background: WOOD, alignItems: 'center', justifyContent: 'center' }, div({ width: 12, height: 12, borderRadius: 6, background: INK })),
      div({ width: nosePx, height: 16, marginLeft: -4, borderRadius: '0 8px 8px 0', background: WOOD }),
    ),
    div({ fontSize: size, fontWeight: 800, lineHeight: 1.15, letterSpacing: -1 }, headline),
    div(
      { flexDirection: 'column' },
      div({ fontSize: 30, fontFamily: 'Mono', color: TONE[d.tone] }, d.verdict),
      div({ fontSize: 24, marginTop: 10, color: WOOD }, d.meta),
    ),
    div(
      { justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 20, borderTop: `2px solid ${WOOD}`, paddingTop: 20 },
      div({ maxWidth: 820 }, d.stats),
      div({ fontFamily: 'Mono', fontSize: 24, fontWeight: 400 }, 'npx pinocchio-cli'),
    ),
  );
  const svg = await satori(tree as any, {
    width: 1200,
    height: 675,
    fonts: [font('inter', 400, 'Inter'), font('inter', 800, 'Inter'), font('jetbrains-mono', 400, 'Mono')],
  });
  return new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } }).render().asPng();
}
