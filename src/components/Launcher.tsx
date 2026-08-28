import React from 'react';
import { Link } from 'react-router-dom';
import { LanguageToggle, useText } from '../i18n';

/**
 * サンプル一覧のランディングページ。
 *
 * ホバーやメディアクエリはインラインスタイルでは書けないので、
 * このコンポーネントの中に <style> をひとつ置いて、そこにまとめている。
 */
/** 文言はすべて [日本語, English] の組で持つ */
type Text = readonly [string, string];

type Sample = {
  path: string;
  title: Text;
  /** 見出しの脇に添える別名。日本語表示なら英語名、英語表示なら日本語名を出す */
  english: string;
  description: Text;
  tags: readonly [readonly string[], readonly string[]];
  /** カードのサムネイル。無いサンプルは accent 色のグラデーションで代用する */
  image?: string;
  accent: string;
  highlight: Text;
};

const SAMPLES: Sample[] = [
  {
    path: '/komorebi',
    title: ['木漏れ日', 'Komorebi'],
    english: 'Komorebi',
    description: [
      '太陽の位置に置いたカメラから葉だけを描いて、影マップを毎フレーム焼いている。地面の光の斑も、立ちのぼる光の柱も、舞う塵も、すべてその1枚から導いている。',
      'A camera at the sun draws the leaves alone into a shadow map, rebuilt every frame. The dapples on the ground, the shafts of light and the drifting dust all come from that single map.'
    ],
    tags: [
      ['シャドウマップ', 'レイマーチ', 'glTF'],
      ['Shadow map', 'Ray marching', 'glTF']
    ],
    image: '/images/komorebi.jpg',
    accent: '#7bc86c',
    highlight: ['木1本 107万三角形', '1.07M triangles per tree']
  },
  {
    path: '/water-caustics',
    title: ['日の当たる水面', 'Water Caustics'],
    english: 'Water Caustics',
    description: [
      '波を絵で描くのではなく、256×256 の格子で波動方程式を解いている。水面のきらめきも底で踊る光の網も、同じ1枚の高さ場から出てくる。',
      'The waves are not painted — the wave equation is solved on a 256×256 grid. The glitter on the surface and the net of light on the bed both come from that one height field.'
    ],
    tags: [
      ['波動方程式', 'ping-pong', '集光'],
      ['Wave equation', 'Ping-pong', 'Caustics']
    ],
    image: '/images/water-caustics.jpg',
    accent: '#4aa8e0',
    highlight: ['65,536 セルを毎フレーム2ステップ', '65,536 cells, two steps per frame']
  },
  {
    path: '/flame',
    title: ['炎の揺らぎ', 'Flame'],
    english: 'Flame',
    description: [
      '炎は「面」でしか光らない。だから粒子ではなく、発光する媒質としてレイマーチして薄い膜の重なりを出している。色は黒体放射、脈動は f≈1.5/√D が与える 1.7Hz の渦輪から。',
      'A flame only glows on a surface, so this is ray-marched as an emissive medium rather than built from particles — folded sheets, not points. Colour is black-body radiation; the pulsing is the 1.7 Hz vortex shedding that f ≈ 1.5/√D predicts.'
    ],
    tags: [
      ['レイマーチ', '黒体放射', '渦輪'],
      ['Ray marching', 'Black body', 'Vortex rings']
    ],
    image: '/images/flame.jpg',
    accent: '#ff7a2f',
    highlight: ['薪ごとに立つ6つの火が合流する', 'Six flames, one per log, merging']
  },
  {
    path: '/candle',
    title: ['ロウソクの火', 'Candle'],
    english: 'Candle',
    description: [
      '炎を発光する媒質としてレイマーチする。色は煤の黒体放射、根元の青は化学発光。マイクに息を吹きかけると、その強さに応じて傾き、強すぎると吹き消える。',
      'The flame is ray-marched as an emissive medium. Its colour is black-body radiation from soot; the blue at the base is chemiluminescence. Blow into your microphone and it leans away — blow hard enough and it goes out.'
    ],
    tags: [
      ['レイマーチ', '黒体放射', 'マイク入力'],
      ['Ray marching', 'Black body', 'Microphone']
    ],
    image: '/images/candle.jpg',
    accent: '#ffb545',
    highlight: ['マイクに息を吹きかけると消える', 'Blow it out with your microphone']
  },
  {
    path: '/text-input-3d',
    title: ['文字が舞う3Dテキスト', 'Text Particles'],
    english: 'Text Particles',
    description: [
      '入力した文字を裏キャンバスにラスタライズし、光ったピクセルを粒子の目的地としてテクスチャに焼く。6.5万個がそこへ吸い寄せられて文字になり、Enter で爆散する。',
      'What you type is rasterised on an offscreen canvas, and the lit pixels are baked into a texture as destinations for the particles. 65,536 of them are drawn there to form the letters, until Enter blows them apart.'
    ],
    tags: [
      ['コンピュート', 'DataTexture', 'キー入力'],
      ['Compute', 'DataTexture', 'Keyboard']
    ],
    image: '/images/text-particles.jpg',
    accent: '#4d8dff',
    highlight: ['65,536 粒子', '65,536 particles']
  }
];

const STYLES = `
.lp {
  position: relative;
  --bg: #05070a;
  --ink: #eef2f8;
  --muted: #8b97a8;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: "Hiragino Sans", "Noto Sans JP", system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
.lp a { color: inherit; text-decoration: none; }
.lp-lang { position: absolute; top: 20px; right: 24px; z-index: 2; }

/* --- ヒーロー --- */
.lp-hero {
  position: relative;
  padding: 128px 32px 96px;
  text-align: center;
  overflow: hidden;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}
/* 背景のオーロラ。ゆっくり回るだけの飾り */
.lp-hero::before {
  content: "";
  position: absolute;
  inset: -40% -20%;
  background:
    radial-gradient(38% 42% at 24% 34%, rgba(255, 122, 47, 0.22), transparent 70%),
    radial-gradient(34% 38% at 74% 28%, rgba(74, 168, 224, 0.22), transparent 70%),
    radial-gradient(40% 44% at 52% 74%, rgba(123, 200, 108, 0.16), transparent 70%);
  filter: blur(20px);
  animation: lp-drift 24s ease-in-out infinite alternate;
  pointer-events: none;
}
@keyframes lp-drift {
  from { transform: translate3d(-3%, -2%, 0) scale(1); }
  to   { transform: translate3d(3%, 2%, 0) scale(1.12); }
}
.lp-hero > * { position: relative; }

.lp-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.14em;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.03);
}
.lp-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #6ee7a8;
  box-shadow: 0 0 10px #6ee7a8;
}
.lp-dot.is-off { background: #ff6b5e; box-shadow: 0 0 10px #ff6b5e; }

.lp-title {
  margin: 26px 0 0;
  font-size: clamp(38px, 7vw, 78px);
  line-height: 1.08;
  font-weight: 800;
  letter-spacing: -0.02em;
  background: linear-gradient(96deg, #ffffff 12%, #9fd0ff 46%, #ffb27a 88%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lp-lead {
  margin: 22px auto 0;
  max-width: 620px;
  font-size: clamp(14px, 1.6vw, 16px);
  line-height: 2;
  color: var(--muted);
}
.lp-stats {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 14px 40px;
  margin-top: 44px;
}
.lp-stat-value { font-size: 26px; font-weight: 700; letter-spacing: -0.01em; }
.lp-stat-label { margin-top: 4px; font-size: 11px; letter-spacing: 0.16em; color: var(--muted); }

.lp-warn {
  max-width: 620px;
  margin: 36px auto 0;
  padding: 14px 18px;
  border: 1px solid rgba(255, 107, 94, 0.4);
  border-radius: 12px;
  background: rgba(255, 107, 94, 0.08);
  font-size: 13px;
  line-height: 1.9;
  color: #ffc9c3;
}

/* --- カード --- */
.lp-main { max-width: 1180px; margin: 0 auto; padding: 84px 32px 40px; }
.lp-section-head {
  display: flex;
  align-items: baseline;
  gap: 16px;
  margin-bottom: 28px;
}
.lp-section-title { font-size: 20px; font-weight: 700; letter-spacing: 0.02em; }
.lp-section-note { font-size: 12px; color: var(--muted); letter-spacing: 0.08em; }

.lp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 22px;
}
.lp-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  background: #0a0d13;
  overflow: hidden;
  transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1), border-color 0.28s, box-shadow 0.28s;
}
.lp-card:hover {
  transform: translateY(-6px);
  border-color: var(--accent);
  box-shadow: 0 18px 46px -22px var(--accent);
}
.lp-thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #05070a;
  overflow: hidden;
}
.lp-thumb img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.lp-card:hover .lp-thumb img { transform: scale(1.06); }
/* 画像が無いサンプルは、そのサンプルの色で光らせておく */
.lp-thumb-fallback {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(50% 62% at 50% 74%, var(--accent), transparent 68%),
    radial-gradient(30% 40% at 50% 52%, rgba(255, 255, 255, 0.5), transparent 70%),
    linear-gradient(180deg, #05070a, #0d1119);
  opacity: 0.72;
  transition: opacity 0.4s;
}
.lp-card:hover .lp-thumb-fallback { opacity: 0.92; }
.lp-thumb-glyph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  letter-spacing: 0.42em;
  text-indent: 0.42em;
  color: rgba(255, 255, 255, 0.72);
}
.lp-highlight {
  position: absolute;
  left: 12px; bottom: 12px;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(3, 5, 8, 0.72);
  backdrop-filter: blur(6px);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: #dfe6f0;
  font-variant-numeric: tabular-nums;
}

.lp-body { padding: 20px 20px 22px; display: flex; flex-direction: column; gap: 12px; flex: 1; }
.lp-card-title { display: flex; align-items: baseline; gap: 10px; }
.lp-card-title h3 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: 0.01em; }
.lp-card-title span { font-size: 11px; letter-spacing: 0.14em; color: var(--muted); }
.lp-card-desc { margin: 0; font-size: 13px; line-height: 1.95; color: #aab6c6; flex: 1; }
.lp-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.lp-tag {
  padding: 4px 9px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 11px;
  color: var(--muted);
}
.lp-open {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
}
.lp-open span { transition: transform 0.25s; }
.lp-card:hover .lp-open span { transform: translateX(4px); }

/* --- フッター --- */
.lp-foot {
  max-width: 1180px;
  margin: 0 auto;
  padding: 40px 32px 96px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 2.1;
}
.lp-foot code {
  padding: 2px 7px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 12px;
  color: #d7e0ec;
}
.lp-foot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 28px;
  padding-top: 28px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.lp-foot h4 { margin: 0 0 6px; font-size: 12px; letter-spacing: 0.14em; color: #dfe6f0; }

@media (max-width: 640px) {
  .lp-hero { padding: 84px 22px 68px; }
  .lp-main { padding: 56px 22px 32px; }
  .lp-foot { padding: 32px 22px 72px; }
}
@media (prefers-reduced-motion: reduce) {
  .lp-hero::before { animation: none; }
  .lp-card, .lp-thumb img, .lp-open span { transition: none; }
}
`;

const hasWebGPU = () => typeof navigator !== 'undefined' && 'gpu' in navigator;

const Launcher: React.FC = () => {
  const webgpu = hasWebGPU();
  const t = useText();

  return (
    <div className="lp">
      <style>{STYLES}</style>

      <div className="lp-lang">
        <LanguageToggle />
      </div>

      <header className="lp-hero">
        <div className="lp-badge">
          <span className={`lp-dot${webgpu ? '' : ' is-off'}`} />
          {webgpu ? t('WebGPU 有効', 'WebGPU enabled') : t('WebGPU 無効', 'WebGPU unavailable')} ・ Three.js
          r185 ・ TSL
        </div>

        <h1 className="lp-title">
          {t(
            <>
              WebGPU で描く、
              <br />
              光と粒子のサンプル集
            </>,
            <>
              Light and particles,
              <br />
              drawn with WebGPU
            </>
          )}
        </h1>

        <p className="lp-lead">
          {t(
            '素の Three.js と TSL（Three.js Shading Language）だけで書いた WebGPU のサンプルです。影も波も炎も、見た目を真似るのではなく、その場で物理から計算しています。',
            'WebGPU samples written with plain Three.js and TSL (Three.js Shading Language). The shadows, the waves and the flames are not imitated — they are computed from physics, in real time.'
          )}
        </p>

        <div className="lp-stats">
          <div>
            <div className="lp-stat-value">{SAMPLES.length}</div>
            <div className="lp-stat-label">{t('サンプル', 'SAMPLES')}</div>
          </div>
          <div>
            <div className="lp-stat-value">1,070,000</div>
            <div className="lp-stat-label">{t('三角形（木1本）', 'TRIANGLES (one tree)')}</div>
          </div>
          <div>
            <div className="lp-stat-value">60 fps</div>
            <div className="lp-stat-label">{t('目標', 'TARGET')}</div>
          </div>
          <div>
            <div className="lp-stat-value">0</div>
            <div className="lp-stat-label">{t('実行時の外部通信', 'NETWORK CALLS AT RUNTIME')}</div>
          </div>
        </div>

        {!webgpu && (
          <p className="lp-warn">
            {t(
              'このブラウザは WebGPU に対応していません。各サンプルは代わりに案内文が表示されます。Chrome / Edge / Safari の最新版でお試しください。',
              'This browser does not support WebGPU, so the samples will show a notice instead. Please try the latest Chrome, Edge, or Safari.'
            )}
          </p>
        )}
      </header>

      <main className="lp-main">
        <div className="lp-section-head">
          <h2 className="lp-section-title">{t('サンプル', 'Samples')}</h2>
          <span className="lp-section-note">{t('クリックで起動します', 'Click to launch')}</span>
        </div>

        <div className="lp-grid">
          {SAMPLES.map((sample) => (
            <Link
              key={sample.path}
              to={sample.path}
              className="lp-card"
              style={{ ['--accent' as string]: sample.accent }}
            >
              <div className="lp-thumb">
                {sample.image ? (
                  <img src={sample.image} alt={t(...sample.title)} loading="lazy" />
                ) : (
                  <>
                    <div className="lp-thumb-fallback" />
                    <div className="lp-thumb-glyph">{sample.english.toUpperCase()}</div>
                  </>
                )}
                <div className="lp-highlight">{t(...sample.highlight)}</div>
              </div>

              <div className="lp-body">
                <div className="lp-card-title">
                  <h3>{t(...sample.title)}</h3>
                  <span>{t(sample.english, sample.title[0])}</span>
                </div>
                <p className="lp-card-desc">{t(...sample.description)}</p>
                <div className="lp-tags">
                  {t(...sample.tags).map((tag) => (
                    <span key={tag} className="lp-tag">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="lp-open">
                  {t('開く', 'Open')} <span>→</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot-grid">
          <div>
            <h4>{t('ビルド', 'Build')}</h4>
            {t(
              <>
                <code>npm run build</code> でバンドルし直し、<code>node server.js</code> で配信しています。
                型チェックは <code>npx tsc --noEmit</code> を別に実行します。
              </>,
              <>
                <code>npm run build</code> bundles, <code>node server.js</code> serves. Type checking is a
                separate <code>npx tsc --noEmit</code>.
              </>
            )}
          </div>
          <div>
            <h4>{t('素材', 'Assets')}</h4>
            {t(
              <>
                3D モデルとテクスチャは Poly Haven（CC0）のものをリポジトリに同梱しています。
                ロウソクのサンプルだけは、すべて手続き生成です。
              </>,
              <>
                The models and textures are from Poly Haven (CC0) and are bundled with the repository.
                The candle scene alone is entirely procedural.
              </>
            )}
          </div>
          <div>
            <h4>{t('言語', 'Language')}</h4>
            {t(
              'ブラウザの言語設定とタイムゾーンから自動で選んでいます。右上のボタンでいつでも切り替えられます。',
              'Chosen automatically from your browser language and time zone. Use the button in the top-right corner to switch at any time.'
            )}
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Launcher;
