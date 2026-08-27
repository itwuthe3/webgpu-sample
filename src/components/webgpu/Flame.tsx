import React, { useCallback } from 'react';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  CircleGeometry,
  Color,
  Fog,
  Mesh,
  MeshStandardNodeMaterial,
  type MeshStandardMaterial,
  Object3D,
  PointLight,
  RenderPipeline,
  Sprite,
  SpriteNodeMaterial,
  Vector3
} from 'three/webgpu';
import {
  Fn,
  If,
  color,
  cos,
  deltaTime,
  float,
  instancedArray,
  instanceIndex,
  mix,
  mx_fractal_noise_float,
  mx_fractal_noise_vec3,
  pass,
  positionWorld,
  texture,
  rand,
  sin,
  smoothstep,
  time,
  uv,
  vec2,
  vec3,
  vec4
} from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import WebGPUCanvas, { SceneSetup } from './WebGPUCanvas';

/**
 * 炎の揺らぎ。
 *
 * 22万個の粒子を1本のコンピュートシェーダーで更新する。各粒子は
 * 「浮力で上昇 → fractal noise の乱流に舐められて崩れる → 寿命が尽きたら根元で再生成」
 * を繰り返し、残り寿命を温度とみなして白 → 黄 → 橙 → 赤 → 消滅へと色を変える。
 */
const PARTICLE_COUNT = 220000;

const ASSETS = '/assets/polyhaven';

/** 炎の根元の半径 */
const BASE_RADIUS = 0.40;

const setup: SceneSetup = async ({ renderer, scene, camera, canvas }) => {
  // --- 外部アセット（Poly Haven / CC0。assets/polyhaven/CREDITS.md 参照） ---
  const gltfLoader = new GLTFLoader();
  const [firewoodGltf, boulderGltf] = await Promise.all([
    gltfLoader.loadAsync(`${ASSETS}/bark_debris_01/bark_debris_01_1k.gltf`),
    gltfLoader.loadAsync(`${ASSETS}/namaqualand_boulders_01/namaqualand_boulders_01_1k.gltf`)
  ]);

  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.6;

  scene.fog = new Fog(0x05070a, 8, 26);

  camera.position.set(0, 2.0, 6.0);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.3, 0);
  controls.enableDamping = true;
  controls.minDistance = 2.5;
  controls.maxDistance = 16;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.update();

  // --- ストレージバッファ（コンピュートシェーダーが読み書きする粒子の状態） ---
  const positionBuffer = instancedArray(PARTICLE_COUNT, 'vec3');
  const velocityBuffer = instancedArray(PARTICLE_COUNT, 'vec3');
  const lifeBuffer = instancedArray(PARTICLE_COUNT, 'float'); // 残り寿命 1 → 0
  const seedBuffer = instancedArray(PARTICLE_COUNT, 'float'); // 粒子ごとの個体差 0..1

  /** seed のうち、この値より大きい粒子は寿命の長い「火の粉」として振る舞う */
  const EMBER_THRESHOLD = 0.991;

  const computeInit = Fn(() => {
    const position = positionBuffer.element(instanceIndex);
    const velocity = velocityBuffer.element(instanceIndex);
    const life = lifeBuffer.element(instanceIndex);
    const seed = seedBuffer.element(instanceIndex);

    const id = instanceIndex.toFloat();
    seed.assign(rand(vec2(id.mul(0.0013), 7.31)));

    const angle = rand(vec2(id.mul(0.0007), 1.13)).mul(Math.PI * 2);
    const radius = rand(vec2(id.mul(0.0011), 3.71)).sqrt().mul(BASE_RADIUS);

    position.assign(vec3(cos(angle).mul(radius), rand(vec2(id.mul(0.0017), 5.11)).mul(1.6), sin(angle).mul(radius)));
    velocity.assign(vec3(0));
    // 初期状態から炎全体が立ち上がっているよう、寿命をばらけさせておく
    life.assign(rand(vec2(id.mul(0.0019), 9.53)));
  })().compute(PARTICLE_COUNT);

  const computeUpdate = Fn(() => {
    const position = positionBuffer.element(instanceIndex);
    const velocity = velocityBuffer.element(instanceIndex);
    const life = lifeBuffer.element(instanceIndex);
    const seed = seedBuffer.element(instanceIndex);

    const dt = deltaTime.min(1 / 30);

    /** 粒子ごと・再生成ごとに変わる乱数 */
    const noiseFor = (salt: number) => rand(vec2(seed.mul(91.7).add(salt), time.mul(0.37).add(salt * 1.7)));

    const ember = smoothstep(EMBER_THRESHOLD, EMBER_THRESHOLD + 0.006, seed);

    // 温度。寿命が残っているほど熱い＝根元ほど熱い
    const heat = smoothstep(0.0, 0.55, life);

    // 炎を舐め上げる乱流。時間軸を下向きに流すことで、渦が上へ送られていくように見える。
    // 低い周波数を主役にすると、点の集まりではなく「舌」として動く。
    const noiseInput = position
      .mul(vec3(1.5, 0.9, 1.5))
      .add(vec3(0, time.mul(-1.5), 0))
      .add(seed.mul(19.0));
    const turbulence = mx_fractal_noise_vec3(noiseInput, 3, 2.0, 0.5, 1.0);
    const turbulenceGain = mix(float(6.6), float(2.0), heat).add(ember.mul(3.0));

    // 炎全体のゆったりとしたそよぎ。根元は安定していて、穂先ほど大きく振れる
    const sway = vec3(
      sin(time.mul(0.83)).mul(0.62).add(sin(time.mul(1.71).add(1.3)).mul(0.28)),
      0.0,
      cos(time.mul(0.67)).mul(0.55).add(cos(time.mul(1.43).add(2.1)).mul(0.24))
    ).mul(smoothstep(0.25, 2.6, position.y).mul(2.2));

    // 浮力と、炎の柱をまとめるための中心方向への引き戻し
    const buoyancy = heat.mul(7.2).add(0.5).mul(mix(float(1.0), float(0.42), ember));
    const inward = mix(float(4.6), float(1.1), heat).mul(mix(float(1.0), float(0.25), ember));

    const acceleration = vec3(
      turbulence.x.mul(turbulenceGain).sub(position.x.mul(inward)).add(sway.x),
      buoyancy.add(turbulence.y.mul(turbulenceGain).mul(0.3)),
      turbulence.z.mul(turbulenceGain).sub(position.z.mul(inward)).add(sway.z)
    );

    velocity.addAssign(acceleration.mul(dt));
    velocity.mulAssign(float(1.0).sub(dt.mul(2.0))); // 空気抵抗
    position.addAssign(velocity.mul(dt));

    const burnRate = mix(float(1.75), float(0.34), ember).mul(seed.mul(0.5).add(0.75));
    life.subAssign(dt.mul(burnRate));

    If(life.lessThanEqual(0.0), () => {
      const angle = noiseFor(0.21).mul(Math.PI * 2);
      const radius = noiseFor(0.43).sqrt().mul(BASE_RADIUS);
      position.assign(vec3(cos(angle).mul(radius), noiseFor(0.67).mul(0.12), sin(angle).mul(radius)));
      velocity.assign(vec3(0, noiseFor(0.89).mul(0.8).add(0.4), 0));
      life.assign(1.0);
    });
  })().compute(PARTICLE_COUNT);

  renderer.computeAsync(computeInit);

  // --- 描画 ---
  const life = lifeBuffer.toAttribute();
  const seed = seedBuffer.toAttribute();
  const ember = smoothstep(EMBER_THRESHOLD, EMBER_THRESHOLD + 0.006, seed);

  // 残り寿命＝温度として色を決める（消えかけの暗赤から、根元の淡い黄まで）
  const ramp1 = mix(color(0x1c0700), color(0xc4280a), smoothstep(0.03, 0.3, life));
  const ramp2 = mix(ramp1, color(0xff7410), smoothstep(0.26, 0.54, life));
  const ramp3 = mix(ramp2, color(0xffb43c), smoothstep(0.54, 0.78, life));
  const flameColor = mix(ramp3, color(0xffdfa6), smoothstep(0.8, 0.99, life));

  // 火の粉はちらちらと明滅させる
  const twinkle = sin(time.mul(24.0).add(seed.mul(120.0))).mul(0.4).add(0.75);
  const particleColor = mix(flameColor, color(0xffa63f).mul(twinkle), ember);

  // スプライトを丸く見せるための減衰（加算合成なので、そのまま明るさになる）
  const falloff = smoothstep(0.5, 0.05, uv().sub(0.5).length());
  const fadeIn = smoothstep(0.0, 0.28, float(1.0).sub(life)); // 生成直後の一点集中を散らす
  const fadeOut = smoothstep(0.0, 0.3, life);
  const alpha = falloff.mul(fadeIn).mul(fadeOut).mul(mix(float(0.04), float(0.36), ember));

  const material = new SpriteNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false
  });
  material.positionNode = positionBuffer.toAttribute();
  const spriteWidth = mix(float(0.058), float(0.018), ember).mul(mix(float(1.7), float(0.6), life));
  material.scaleNode = vec2(spriteWidth, spriteWidth.mul(mix(float(1.55), float(1.0), ember)));
  // トーンマッピングで潰す前提で、根元だけ持ち上げて発光感を出す
  const emission = mix(float(1.0), float(1.3), smoothstep(0.45, 1.0, life));
  material.colorNode = vec4(particleColor.mul(emission), alpha);

  const particles = new Sprite(material);
  particles.count = PARTICLE_COUNT;
  particles.frustumCulled = false;
  scene.add(particles);

  // --- 焚き火まわり ---

  /** 地面の起伏を作るための、簡単な擬似ノイズ */
  const wobble = (v: Vector3, seed: number) =>
    Math.sin(v.x * 3.1 + seed) * 0.5 +
    Math.sin(v.y * 4.3 + seed * 1.7) * 0.32 +
    Math.sin(v.z * 2.7 + seed * 2.3) * 0.24 +
    Math.sin((v.x + v.z) * 7.9 + seed) * 0.12;

  /** 炎の根元にどれだけ近いか。焦げと熾火の分布に使う */
  const nearFire = smoothstep(0.8, 0.1, positionWorld.xz.length()).mul(
    smoothstep(1.0, 0.02, positionWorld.y)
  );

  // 地面：起伏を付けて、中心に向かって焼けた灰の輪を敷く
  const groundGeometry = new CircleGeometry(9, 128, 0, Math.PI * 2);
  {
    const position = groundGeometry.attributes.position;
    const vertex = new Vector3();
    for (let i = 0; i < position.count; i += 1) {
      vertex.fromBufferAttribute(position, i);
      // CircleGeometry は XY 平面なので、Z が高さになる
      const distance = Math.hypot(vertex.x, vertex.y);
      position.setZ(i, wobble(new Vector3(vertex.x * 0.5, 0, vertex.y * 0.5), 1.3) * 0.09 * Math.min(distance / 2, 1));
    }
    groundGeometry.computeVertexNormals();
  }
  const groundMaterial = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  {
    const grain = mx_fractal_noise_float(vec3(positionWorld.xz.mul(3.4), 0.0), 4, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
    const pebbles = smoothstep(0.66, 0.78, grain);
    const soil = mix(color(0x241c14), color(0x3b3226), grain);
    const withPebbles = mix(soil, color(0x4b463d), pebbles.mul(0.6));
    // 焚き火の直下は灰と焦げ
    const ash = smoothstep(2.4, 0.7, positionWorld.xz.length());
    groundMaterial.colorNode = mix(withPebbles, mix(color(0x0d0b09), color(0x6b6560), grain.mul(0.5)), ash);
    groundMaterial.roughnessNode = mix(float(1.0), float(0.85), pebbles);
  }
  const ground = new Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  /** 読み込んだモデルを、焚き火の熱に合わせて塗り直す */
  const adopt = (source: Object3D, kind: 'wood' | 'stone') => {
    const clone = source.clone(true);
    clone.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const original = mesh.material as MeshStandardMaterial;
      const albedo = original.map ? texture(original.map).rgb : color(0x4a423a);
      const material = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });

      if (kind === 'wood') {
        // 火に近い側は炭化する。炭の割れ目から熾火が覗き、ゆっくり明滅する
        const emberNoise = mx_fractal_noise_float(vec3(positionWorld.mul(14.0)), 3, 2.0, 0.5, 1.0)
          .mul(0.5)
          .add(0.5);
        const ember = smoothstep(0.58, 0.8, emberNoise).mul(nearFire);
        const pulse = sin(time.mul(2.7).add(emberNoise.mul(40.0))).mul(0.3).add(0.7);

        material.colorNode = mix(albedo, color(0x0a0807), nearFire);
        material.emissiveNode = mix(color(0xff3d05), color(0xffc46a), ember).mul(ember.mul(pulse).mul(3.0));
        material.roughnessNode = mix(float(0.95), float(0.6), nearFire);
      } else {
        // 火に向いた面は煤で黒ずむ
        material.colorNode = mix(albedo, color(0x171412), nearFire.mul(0.85));
        material.roughnessNode = float(0.92);
      }
      mesh.material = material;
    });
    return clone;
  };

  // 薪。火をまたぐように井桁に組む
  const firewood = firewoodGltf.scene.children.slice();
  ([
    // [ずれX, ずれZ, y, 向き, 大きさ]
    [-0.05, 0.14, 0.06, 0.35, 3.1],
    [0.1, -0.08, 0.1, 1.85, 2.8],
    [-0.02, -0.02, 0.22, 3.05, 2.4],
    [0.3, 0.36, 0.05, 2.45, 2.0]
  ] as const).forEach(([dx, dz, y, yaw, scale], index) => {
    const log = adopt(firewood[index % firewood.length], 'wood');
    log.position.set(dx, y, dz);
    log.rotation.set(0, yaw, 0);
    log.scale.setScalar(scale);
    scene.add(log);
  });

  // 囲いの石
  const boulders = boulderGltf.scene.children.slice();
  for (let i = 0; i < 15; i += 1) {
    const stone = adopt(boulders[i % boulders.length], 'stone');
    const angle = (i / 15) * Math.PI * 2 + Math.sin(i * 3.1) * 0.12;
    const radius = 1.62 + Math.sin(i * 7.7) * 0.09;
    const scale = 1.0 + Math.abs(Math.sin(i * 5.3)) * 0.65;
    stone.position.set(Math.cos(angle) * radius, 0.0, Math.sin(angle) * radius);
    stone.scale.setScalar(scale);
    stone.rotation.set(0, i * 2.3, 0);
    scene.add(stone);
  }

  // 地面に散らばる小石
  for (let i = 0; i < 40; i += 1) {
    const pebble = adopt(boulders[(i * 3 + 1) % boulders.length], 'stone');
    const angle = i * 2.39996;
    const radius = 2.2 + Math.sqrt((i + 0.5) / 40) * 4.6;
    const scale = 0.16 + Math.abs(Math.sin(i * 4.1)) * 0.26;
    pebble.position.set(Math.cos(angle) * radius, 0.0, Math.sin(angle) * radius);
    pebble.scale.set(scale, scale * 0.7, scale);
    pebble.rotation.set(0, i * 1.3, 0);
    scene.add(pebble);
  }

  const fireLight = new PointLight(0xff8a3c, 16, 20, 1.6);
  fireLight.position.set(0, 0.7, 0);
  scene.add(fireLight);
  scene.add(new AmbientLight(0x16223c, 2.2));

  const lightColor = new Color();

  // --- ポストエフェクト（炎と熾火が滲むように） ---
  const renderPipeline = new RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  renderPipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.45, 0.8, 1.0));

  return {
    update: (elapsed) => {
      controls.update();
      renderer.compute(computeUpdate);

      // 焚き火の照り返しの揺らぎ（CPU側の簡易ノイズ）
      const flicker =
        Math.sin(elapsed * 7.3) * 0.5 + Math.sin(elapsed * 13.7) * 0.3 + Math.sin(elapsed * 23.1) * 0.2;
      fireLight.intensity = 15 + flicker * 4.6;
      fireLight.position.x = Math.sin(elapsed * 3.1) * 0.05;
      fireLight.position.z = Math.cos(elapsed * 2.7) * 0.05;
      lightColor.setHSL(0.055 + flicker * 0.006, 0.95, 0.55);
      fireLight.color.copy(lightColor);
    },
    render: () => {
      renderPipeline.render();
    },
    dispose: () => {
      controls.dispose();
    }
  };
};

const Flame: React.FC = () => {
  const memoizedSetup = useCallback(setup, []);
  return (
    <WebGPUCanvas
      title="炎の揺らぎ"
      hint={
        <>
          22万個の粒子をコンピュートシェーダーで更新しています。
          <br />
          ドラッグで回転、スクロールでズーム。
        </>
      }
      setup={memoizedSetup}
    />
  );
};

export default Flame;
