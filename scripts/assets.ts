// Regenerates the README images in docs/ from the sample logs in scripts/demo.ts.
// Usage: node scripts/assets.ts   (the terminal GIF comes from `vhs scripts/demo.tape`)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

const root = join(import.meta.dirname, '..');
const docs = join(root, 'docs');
mkdirSync(docs, { recursive: true });

const home = mkdtempSync(join(tmpdir(), 'pinocchio-demo-'));
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), NO_COLOR: '1' },
  });
  if (r.status) throw new Error(r.stderr);
};
run(['scripts/demo.ts', home]);
run(['src/cli.ts', '--share', '--out', join(docs, 'card.png')]);
run(['src/cli.ts', '--share', '--project', join(home, 'code', 'checkout-api'), '--out', join(docs, 'card-clean.png')]);

// Banner, also used as the GitHub social preview (1280×640).
const require = createRequire(import.meta.url);
const font = (pkg: string, weight: 400 | 800, name: string) => ({
  name,
  weight,
  style: 'normal' as const,
  data: readFileSync(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-${weight}-normal.woff`)),
});
const div = (style: Record<string, unknown>, ...children: unknown[]) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });
const INK = '#2b1d12', WOOD = '#a0652f', PAPER = '#fbf3e4', RED = '#d7263d';
const chip = (label: string, color: string) =>
  div({ padding: '8px 16px', borderRadius: 10, border: `2px solid ${color}`, color, fontFamily: 'Mono', fontSize: 22, marginRight: 14 }, label);

const banner = div(
  { width: 1280, height: 640, boxSizing: 'border-box', flexDirection: 'column', justifyContent: 'space-between', padding: '64px 80px', background: PAPER, color: INK, fontFamily: 'Inter' },
  div(
    { alignItems: 'center', justifyContent: 'space-between' },
    div({ fontSize: 30, fontWeight: 800, letterSpacing: 8, color: WOOD }, 'PINOCCHIO'),
    div({ fontSize: 26, fontFamily: 'Mono', color: RED }, 'nose: 2 cm'),
  ),
  div(
    { flexDirection: 'column' },
    div({ fontSize: 76, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05 }, '“All 42 tests pass.”'),
    div({ fontSize: 30, fontFamily: 'Mono', color: RED, marginTop: 18 }, 'said 48s after `pytest -q` failed'),
  ),
  div(
    { alignItems: 'center' },
    div({ width: 72, height: 72, borderRadius: 36, background: WOOD, alignItems: 'center', justifyContent: 'center' }, div({ width: 14, height: 14, borderRadius: 7, background: INK })),
    div({ width: 520, height: 18, marginLeft: -4, borderRadius: '0 9px 9px 0', background: WOOD }),
  ),
  div(
    { flexDirection: 'column' },
    div({ fontSize: 30, lineHeight: 1.3, marginBottom: 26 }, 'Checks your coding agent’s “tests pass” against the commands it actually ran.'),
    div(
      { alignItems: 'center', justifyContent: 'space-between' },
      div({}, chip('VERIFIED', '#2f8f4e'), chip('STALE', '#c77d0a'), chip('UNVERIFIED', '#7a6a5a'), chip('CONTRADICTED', RED)),
      div({ background: INK, color: PAPER, fontFamily: 'Mono', fontSize: 26, padding: '12px 22px', borderRadius: 12 }, 'npx pinocchio-cli'),
    ),
  ),
);
const svg = await satori(banner as any, {
  width: 1280,
  height: 640,
  fonts: [font('inter', 400, 'Inter'), font('inter', 800, 'Inter'), font('jetbrains-mono', 400, 'Mono')],
});
writeFileSync(join(docs, 'banner.png'), new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } }).render().asPng());
console.log(`wrote docs/banner.png, docs/card.png, docs/card-clean.png (sample logs in ${home})`);
