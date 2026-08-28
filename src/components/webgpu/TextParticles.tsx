import React, { MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  Color,
  DataTexture,
  FloatType,
  Fog,
  Mesh,
  MeshStandardNodeMaterial,
  NearestFilter,
  PlaneGeometry,
  PointLight,
  RGBAFormat,
  RenderPipeline,
  Sprite,
  SpriteNodeMaterial
} from 'three/webgpu';
import {
  Fn,
  color,
  deltaTime,
  float,
  fract,
  instancedArray,
  instanceIndex,
  int,
  ivec2,
  max,
  mix,
  mx_fractal_noise_vec3,
  pass,
  positionWorld,
  rand,
  sin,
  smoothstep,
  textureLoad,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import WebGPUCanvas, { SceneSetup } from './WebGPUCanvas';
import { useText } from '../../i18n';

/**
 * 文字が舞う3Dテキスト（旧 React Three Fiber 版の WebGPU 移植）。
 *
 * 文字そのものをメッシュでは描かない。裏キャンバスに 2D で文字を描き、
 * 光ったピクセルを「粒子の目的地」として RGBA float のテクスチャに焼いて、
 * 6.5万個の粒子がそこへバネで吸い寄せられることで文字の形が浮かび上がる。
 * Enter を押すと目的地を無視して外向きの力に切り替わり、そのまま爆散する。
 *
 * 目的地をストレージバッファではなくテクスチャで渡しているのは、キー入力の
 * たびに CPU 側から書き換えるため（テクスチャなら needsUpdate だけで済む）。
 */
const PARTICLE_COUNT = 65536;
/** 目的地テクスチャの一辺。PARTICLE_COUNT === TEX_SIZE * TEX_SIZE */
const TEX_SIZE = 256;

/** 文字をラスタライズする裏キャンバスの解像度 */
const GLYPH_W = 1536;
const GLYPH_H = 288;
/** 裏キャンバスの1ピクセルがワールドで何ユニットか（横幅 10 ユニットに収まる） */
const GLYPH_SCALE = 10.0 / GLYPH_W;

/** 入力を受け付ける最大文字数（これ以上は文字が潰れて読めない） */
const MAX_LENGTH = 24;
/** Enter を押してから文字が消えるまでの秒数 */
const BURST_DURATION = 2.0;

type TextParticlesApi = {
  /** 表示する文字列を差し替える */
  setText: (text: string) => void;
  /** 爆散させる */
  burst: () => void;
  /** 爆散後、粒子を原点へ戻して待機状態にする */
  reset: () => void;
};

const createSetup =
  (apiRef: MutableRefObject<TextParticlesApi | null>, initialText: () => string): SceneSetup =>
  async ({ renderer, scene, camera, canvas }) => {
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;

    scene.fog = new Fog(0x05070a, 14, 40);

    camera.position.set(0, 0.6, 9.4);

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.minDistance = 3;
    controls.maxDistance = 24;
    controls.maxPolarAngle = Math.PI * 0.86;
    controls.update();

    // --- 目的地テクスチャ（粒子1個につき1テクセル。xyz が目的地、w が有効フラグ） ---
    const targetData = new Float32Array(TEX_SIZE * TEX_SIZE * 4);
    const targetTexture = new DataTexture(targetData, TEX_SIZE, TEX_SIZE, RGBAFormat, FloatType);
    targetTexture.minFilter = NearestFilter;
    targetTexture.magFilter = NearestFilter;
    targetTexture.needsUpdate = true;

    const glyphCanvas = document.createElement('canvas');
    glyphCanvas.width = GLYPH_W;
    glyphCanvas.height = GLYPH_H;
    const glyph = glyphCanvas.getContext('2d', { willReadFrequently: true });
    if (!glyph) throw new Error('2D コンテキストを作成できませんでした');

    const fontOf = (size: number) =>
      `700 ${size}px "Helvetica Neue", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;

    /** 文字を裏キャンバスに描き、光ったピクセルへ粒子の目的地を割り当て直す */
    const updateTargets = (text: string) => {
      if (text.length === 0) {
        targetData.fill(0);
        targetTexture.needsUpdate = true;
        return;
      }

      glyph.clearRect(0, 0, GLYPH_W, GLYPH_H);
      glyph.fillStyle = '#ffffff';
      glyph.textAlign = 'center';
      glyph.textBaseline = 'middle';

      // 文字数が増えたら、はみ出さないようフォントサイズを詰める
      let size = GLYPH_H * 0.66;
      glyph.font = fontOf(size);
      const measured = glyph.measureText(text).width;
      const limit = GLYPH_W * 0.94;
      if (measured > limit) {
        size *= limit / measured;
        glyph.font = fontOf(size);
      }
      glyph.fillText(text, GLYPH_W / 2, GLYPH_H / 2);

      const pixels = glyph.getImageData(0, 0, GLYPH_W, GLYPH_H).data;
      const lit: number[] = [];
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 120) lit.push((i - 3) / 4);
      }
      if (lit.length === 0) {
        targetData.fill(0);
        targetTexture.needsUpdate = true;
        return;
      }

      // 粒子ごとに、光ったピクセルの中から1点を選ぶ（毎回選び直すので文字が組み替わる）
      for (let i = 0; i < PARTICLE_COUNT; i += 1) {
        const pixel = lit[(Math.random() * lit.length) | 0];
        const px = pixel % GLYPH_W;
        const py = (pixel / GLYPH_W) | 0;
        const offset = i * 4;
        targetData[offset] = (px + Math.random() - GLYPH_W / 2) * GLYPH_SCALE;
        targetData[offset + 1] = (GLYPH_H / 2 - py - Math.random()) * GLYPH_SCALE;
        // 板に見えないよう、わずかに厚みを持たせる
        targetData[offset + 2] = (Math.random() - 0.5) * 0.18;
        targetData[offset + 3] = 1;
      }
      targetTexture.needsUpdate = true;
    };

    // --- 粒子の状態 ---
    const positionBuffer = instancedArray(PARTICLE_COUNT, 'vec3');
    const velocityBuffer = instancedArray(PARTICLE_COUNT, 'vec3');
    const seedBuffer = instancedArray(PARTICLE_COUNT, 'float');

    const explode = uniform(0); // 0 = 文字を形作る / 1 = 爆散中
    const burstAge = uniform(0); // 爆散してからの経過秒
    const burstPower = uniform(0); // 外向きの加速度（時間とともに減衰させる）
    const opacity = uniform(0); // 全体の不透明度（CPU 側でならす）

    const computeInit = Fn(() => {
      const id = instanceIndex.toFloat();
      seedBuffer.element(instanceIndex).assign(rand(vec2(id.mul(0.0013), 4.19)));
      positionBuffer.element(instanceIndex).assign(vec3(0));
      velocityBuffer.element(instanceIndex).assign(vec3(0));
    })().compute(PARTICLE_COUNT);

    /** 爆散したあと、次の入力に備えて粒子を原点付近へ畳み直す */
    const computeReset = Fn(() => {
      const id = instanceIndex.toFloat();
      positionBuffer
        .element(instanceIndex)
        .assign(
          vec3(
            rand(vec2(id.mul(0.0007), 1.71)).sub(0.5).mul(0.5),
            rand(vec2(id.mul(0.0009), 3.37)).sub(0.5).mul(0.5),
            rand(vec2(id.mul(0.0011), 5.53)).sub(0.5).mul(0.5)
          )
        );
      velocityBuffer.element(instanceIndex).assign(vec3(0));
    })().compute(PARTICLE_COUNT);

    const texSize = int(TEX_SIZE);

    const computeUpdate = Fn(() => {
      const position = positionBuffer.element(instanceIndex);
      const velocity = velocityBuffer.element(instanceIndex);
      const seed = seedBuffer.element(instanceIndex);

      const dt = deltaTime.min(1 / 30);

      const index = int(instanceIndex);
      const target = textureLoad(targetTexture, ivec2(index.mod(texSize), index.div(texSize)));

      // 文字の形へ引き寄せるバネ。文字が無いときは目的地が原点なので中央に畳まれる
      const flutter = mx_fractal_noise_vec3(
        position.mul(1.7).add(vec3(0, 0, time.mul(0.8))).add(seed.mul(23.0)),
        2,
        2.0,
        0.5,
        1.0
      );
      const gather = target.xyz.sub(position).mul(58.0).sub(velocity.mul(9.5)).add(flutter.mul(2.4));

      // 爆散：中心から外へ弾け、浮力で持ち上がりながら乱流に崩される
      const radial = position.div(max(position.length(), 0.15));
      const swirl = mx_fractal_noise_vec3(
        position.mul(0.6).add(seed.mul(37.0)).add(vec3(0, time.mul(-0.9), 0)),
        3,
        2.0,
        0.5,
        1.0
      );
      const burst = radial
        .mul(burstPower)
        .add(vec3(0, mix(float(1.2), float(4.4), seed), 0))
        .add(swirl.mul(11.0))
        .sub(velocity.mul(1.5));

      velocity.addAssign(mix(gather, burst, explode).mul(dt));
      position.addAssign(velocity.mul(dt));
    })().compute(PARTICLE_COUNT);

    renderer.computeAsync(computeInit);

    // --- 描画 ---
    const seedAttribute = seedBuffer.toAttribute();
    const shimmer = sin(time.mul(3.1).add(seedAttribute.mul(90.0))).mul(0.5).add(0.5);
    // 文字のあいだは青。粒子ごとに水色へ振って、単色の板に見えないようにする
    const formColor = mix(color(0x1a63ff), color(0xb4e9ff), smoothstep(0.15, 1.0, seedAttribute.mul(0.6).add(shimmer.mul(0.4))));

    // 爆散したら、経過時間そのものを温度に見立てて白 → 橙 → 赤へ落とす
    const burstRamp1 = mix(color(0xfff4cc), color(0xffa32a), smoothstep(0.0, 0.5, burstAge));
    const burstRamp2 = mix(burstRamp1, color(0xff3a12), smoothstep(0.4, 1.1, burstAge));
    const burstColor = mix(burstRamp2, color(0x4d1005), smoothstep(1.0, 1.9, burstAge)).mul(
      mix(float(1.0), float(0.55), seedAttribute)
    );

    const particleColor = mix(formColor, burstColor, explode);

    const falloff = smoothstep(0.5, 0.02, uv().sub(0.5).length());
    const alpha = falloff.mul(opacity).mul(mix(float(0.22), float(0.34), explode));

    const material = new SpriteNodeMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false
    });
    material.positionNode = positionBuffer.toAttribute();
    const spriteSize = mix(float(0.030), float(0.055), explode)
      .mul(seedAttribute.mul(0.5).add(0.75))
      // 見えていないときは潰しておく。原点に全粒子が重なると、そこだけで塗り潰しが破綻する
      .mul(smoothstep(0.0, 0.03, opacity));
    material.scaleNode = vec2(spriteSize, spriteSize);
    material.colorNode = vec4(particleColor, alpha);

    const particles = new Sprite(material);
    particles.count = PARTICLE_COUNT;
    particles.frustumCulled = false;
    scene.add(particles);

    // --- 足元（文字が宙に浮いていることが分かるだけの、薄いグリッド） ---
    const floorMaterial = new MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.1 });
    {
      const cell = fract(positionWorld.xz).sub(0.5).abs();
      const line = smoothstep(0.47, 0.5, max(cell.x, cell.y));
      const fade = smoothstep(30.0, 3.0, positionWorld.xz.length());
      floorMaterial.colorNode = mix(color(0x05070a), color(0x0b1420), fade);
      floorMaterial.emissiveNode = color(0x1b4a7c).mul(line.mul(fade).mul(0.45));
    }
    const floor = new Mesh(new PlaneGeometry(80, 80), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.6;
    scene.add(floor);

    const glow = new PointLight(0x3f8bff, 6, 26, 1.5);
    glow.position.set(0, 0, 1.2);
    scene.add(glow);
    const glowColor = new Color();

    // --- ポストエフェクト（粒子が滲んで文字が発光して見えるように） ---
    const renderPipeline = new RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode('output');
    renderPipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.85, 0.7, 0.8));

    let exploding = false;
    let age = 0;
    let hasText = false;
    let pendingReset = false;

    apiRef.current = {
      setText: (text) => {
        hasText = text.length > 0;
        updateTargets(text);
      },
      burst: () => {
        exploding = true;
        age = 0;
      },
      reset: () => {
        exploding = false;
        age = 0;
        hasText = false;
        updateTargets('');
        // コンピュートは描画ループの中から呼びたいので、ここではフラグだけ立てる
        pendingReset = true;
      }
    };
    // 初期化を待っているあいだに入力されていたぶんを取り込む
    apiRef.current.setText(initialText());

    return {
      update: (_elapsed, delta) => {
        controls.update();

        if (pendingReset) {
          pendingReset = false;
          renderer.compute(computeReset);
        }

        if (exploding) age += delta;
        explode.value = exploding ? 1 : 0;
        burstAge.value = age;
        burstPower.value = exploding ? 34 * Math.exp(-age * 2.2) : 0;

        const targetOpacity = exploding ? Math.max(0, 1 - age / BURST_DURATION) : hasText ? 1 : 0;
        opacity.value += (targetOpacity - opacity.value) * Math.min(1, delta * 12);

        renderer.compute(computeUpdate);

        // 文字の色に合わせて足元の照り返しも変える
        glow.intensity = (exploding ? 26 * Math.exp(-age * 1.8) : 6) * opacity.value;
        glowColor.setHex(exploding ? 0xff7a2a : 0x3f8bff);
        glow.color.copy(glowColor);
      },
      render: () => {
        renderPipeline.render();
      },
      dispose: () => {
        apiRef.current = null;
        controls.dispose();
        targetTexture.dispose();
      }
    };
  };

const TextParticles: React.FC = () => {
  const apiRef = useRef<TextParticlesApi | null>(null);
  const textRef = useRef('');
  const explodingRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const t = useText();
  const [text, setText] = useState('');
  const [exploding, setExploding] = useState(false);

  const setup = useMemo(() => createSetup(apiRef, () => textRef.current), []);

  useEffect(() => {
    const apply = (next: string) => {
      textRef.current = next;
      setText(next);
      apiRef.current?.setText(next);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Enter') {
        if (explodingRef.current || textRef.current.length === 0) return;
        event.preventDefault();
        explodingRef.current = true;
        setExploding(true);
        apiRef.current?.burst();
        timerRef.current = window.setTimeout(() => {
          explodingRef.current = false;
          setExploding(false);
          textRef.current = '';
          setText('');
          apiRef.current?.reset();
        }, BURST_DURATION * 1000);
        return;
      }

      // 爆散しているあいだは入力を受け付けない（文字が戻ってきてしまうため）
      if (explodingRef.current) return;

      if (event.key === 'Backspace') {
        event.preventDefault();
        apply(textRef.current.slice(0, -1));
      } else if (event.key.length === 1) {
        if (textRef.current.length >= MAX_LENGTH) return;
        event.preventDefault();
        apply(textRef.current + event.key);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
      <WebGPUCanvas
        title={t('文字が舞う3Dテキスト', 'Text Particles')}
        hint={t(
          <>
            6.5万個の粒子が、入力した文字の形へ集まります。
            <br />
            キーボードで入力、Enter で爆散。ドラッグで回転。
          </>,
          <>
            65,536 particles gather into the shape of whatever you type.
            <br />
            Type to write, press Enter to blow it apart. Drag to orbit.
          </>
        )}
        setup={setup}
      />

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 32,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none'
        }}
      >
        <div
          style={{
            padding: '10px 20px',
            borderRadius: 999,
            background: 'rgba(0, 0, 0, 0.45)',
            backdropFilter: 'blur(6px)',
            color: '#f2f4f8',
            font: '14px/1.6 system-ui, sans-serif',
            letterSpacing: '0.04em',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {exploding ? (
            t('爆散中…', 'Blowing apart…')
          ) : text.length === 0 ? (
            t('キーボードで文字を入力してください（Enter で爆散）', 'Type something (Enter blows it apart)')
          ) : (
            <>
              <span style={{ opacity: 0.5 }}>{t('入力中: ', 'Typing: ')}</span>
              {text}
              <span style={{ opacity: 0.5 }}>
                {t(` ／ 残り ${MAX_LENGTH - text.length} 文字`, ` / ${MAX_LENGTH - text.length} left`)}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default TextParticles;
