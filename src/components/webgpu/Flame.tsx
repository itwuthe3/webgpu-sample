import React, { useCallback } from 'react';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  CircleGeometry,
  Color,
  Fog,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type MeshStandardMaterial,
  Object3D,
  PointLight,
  RenderPipeline,
  Sprite,
  SpriteNodeMaterial,
  Vector2,
  Vector3
} from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cameraPosition,
  clamp,
  color,
  cos,
  deltaTime,
  exp,
  float,
  instancedArray,
  instanceIndex,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_fractal_noise_vec3,
  mx_noise_float,
  normalize,
  pass,
  positionWorld,
  pow,
  screenUV,
  texture,
  rand,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4
} from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { createGLTFLoader } from './gltf';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import WebGPUCanvas, { SceneSetup } from './WebGPUCanvas';
import { useText } from '../../i18n';
import { blackbodyColor } from './blackbody';

/**
 * 炎の揺らぎ。
 *
 * 炎そのものは**発光する参加媒質**としてレイマーチし、火の粉だけをコンピュートシェーダーの
 * 粒子で飛ばしている。この分担には理由がある。
 *
 * 拡散炎が光るのは、燃料と空気が出会う「面」の上だけ。実際の焚き火が薄いリボンの集まりに
 * 見え、隙間から向こうが透けるのはこのため。粒子はその面を離散的に拾うことしかできず、
 * 22万個まで増やしても「点の集まり」から抜け出せなかった。面そのものを積分すれば繋がる。
 * 逆に火の粉は本当に離散した炭素の粒なので、そちらは粒子が正しい。
 *
 * 色は黒体放射（[blackbody.ts](./blackbody.ts)）。揺らぎは f ≈ 1.5/√D が与える渦輪。
 */
/**
 * 火の粉の数。炎そのものは体積として積分するので、粒子はここだけになった。
 * 火の粉は本当に離散した炭素の粒なので、こちらは粒子で描くのが正しい。
 */
const EMBER_COUNT = 2600;

const ASSETS = '/assets/polyhaven';

/** 火床の半径。渦輪の周波数と火の粉の湧く範囲に使う */
const BASE_RADIUS = 0.40;

/**
 * 薪の置き方。[ずれX, ずれZ, 高さ, 向き, 大きさ]
 * 井桁に整然と組むと作り物に見えるので、崩して積んである
 */
const FIREWOOD = [
  [-0.3, 0.08, 0.05, 0.42, 3.0],
  [0.24, -0.22, 0.07, 1.72, 2.7],
  [-0.06, -0.02, 0.21, 2.95, 2.5],
  [0.31, 0.29, 0.04, 2.35, 2.1],
  [-0.33, -0.27, 0.03, 0.95, 1.9],
  [0.04, 0.35, 0.12, 4.1, 1.7]
] as const;

/**
 * 炎の根元。薪ごとに火が立つので、根元は1つではない。[X, Z, 太さ, 高さの倍率]
 *
 * 焚き火が「ロウソクを大きくしたもの」に見えてしまう一番の原因は、
 * 軸対称な涙型をひとつだけ置くこと。実際は複数の火が別々に立ち上がる。
 */
const FLAME_ROOT_POSITIONS = [
  [-0.38, 0.1, 1.0, 0.9],
  [0.3, -0.26, 0.95, 0.84],
  [-0.05, -0.02, 1.0, 1.0],
  [0.36, 0.32, 0.8, 0.68],
  [-0.4, -0.32, 0.74, 0.6],
  [0.05, 0.42, 0.68, 0.56]
] as const;
/** 根元ひとつぶんの太さ */
const ROOT_RADIUS = 0.2;

/**
 * 近接した拡散炎は独立に振る舞わない。内側どうしのせん断層が干渉し、
 * 間の空気の巻き込みが妨げられるため、
 *
 *   - 互いに引き寄せ合って上で1本に合流する
 *   - 合流すると空気が足りなくなり、背が高くなる
 *   - 脈動の位相が揃う
 *
 * が起きる。位相が揃うか反転するかは間隔で決まり、**近いと同位相・離れると逆位相**。
 * ここでの間隔は根元の径の 1〜2.5 倍で同位相の領域なので、揃える側になる
 * （Vortex-dynamical Interpretation of Anti-phase and In-phase Flickering,
 *  Synchronization in flickering of three-coupled candle flames ほか）。
 */
/** 合流が完了する正規化高さ */
const MERGE_HEIGHT = 0.45;
/** 合流したとき、根元どうしの間隔がどこまで詰まるか */
const MERGE_SHRINK = 0.25;
/** 合流すると空気の巻き込みが妨げられて背が伸びる */
const MERGE_LIFT = 0.3;
/** 結合の遅れ[rad/距離]。中心から遠い火ほど、わずかに遅れて脈動する */
const COUPLING_LAG = 1.1;

/** 根元の重心。合流先はここ */
const ROOT_CENTROID = FLAME_ROOT_POSITIONS.reduce(
  (sum, [x, z]) => [sum[0] + x / FLAME_ROOT_POSITIONS.length, sum[1] + z / FLAME_ROOT_POSITIONS.length],
  [0, 0]
);

/** 重心からの距離を足した根元の情報。位相は距離から決まる（同位相＋わずかな遅れ） */
const FLAME_ROOTS = FLAME_ROOT_POSITIONS.map(([x, z, strength, heightScale]) => {
  const offsetX = x - ROOT_CENTROID[0];
  const offsetZ = z - ROOT_CENTROID[1];
  return {
    offsetX,
    offsetZ,
    strength,
    heightScale,
    phase: Math.hypot(offsetX, offsetZ) * COUPLING_LAG
  };
});
/** 炎のおおよその高さ */
const FLAME_HEIGHT = 2.6;
/**
 * 浮力による渦輪の放出周波数[Hz]。f ≈ 1.5 / sqrt(D)（D は火床の直径[m]）。
 *
 * ロウソク（芯の径 6mm）は臨界サイズ以下でこの自励振動が起きず、常時ちらつかせるのは
 * 誤りだった。焚き火はこの領域の内側にいるので、そのまま効く。直径 0.8m で約 1.7Hz。
 * 焚き火が塊で「ボワッ」と立ちのぼって見えるのは、この渦輪が抜けていくところ。
 */
const PUFF_HZ = 1.5 / Math.sqrt(BASE_RADIUS * 2);
/** プルームの上昇速度[m/s]。浮力と空気抵抗の釣り合いから */
const PLUME_SPEED = 3.6;
/** 炎の高さ方向に渦輪が何個乗るか（f × H / v） */
const VORTEX_WAVES = (PUFF_HZ * FLAME_HEIGHT) / PLUME_SPEED;

/**
 * 炎を包む箱。**風で倒れるぶんを見越して常に大きく取ってはいけない。**
 * ステップ数は固定なので、箱を広げるとレイの行程が伸びて刻みが粗くなり、膜が潰れる。
 * ここは静穏時の大きさだけを持ち、倒れたぶんは毎フレーム風下へずらす（updateWind 参照）。
 */
const BOX_RADIUS = 1.15;
const BOX_BOTTOM = -0.05;
/** 突風のとき炎は 25% ほど伸びるので、その上端（2.6 × 1.25）より高く取っておく */
const BOX_TOP = 3.5;
/** レイマーチのステップ数 */
const STEPS = 64;

/**
 * 突風の最大で穂先がどれだけ倒れるか。炎の高さ 2.6 に対して 2.2 なので、最大で約 40 度傾く。
 * ふつうの突風では 15 度、強いときで 30 度ほど。
 */
const WIND_BEND = 2.2;
/** 倒れ方の高さ依存。滞空時間ぶん横ずれが積み上がる */
const WIND_BEND_POWER = 1.25;
/** 風の履歴を何点サンプルするか（根元から穂先までを等分する） */
const WIND_TAPS = 4;

/** TSL のノードは型が複雑なので、シェーダー組み立て用ヘルパーの引数はこの別名で受ける */
type TSLNode = any;

const setup: SceneSetup = async ({ renderer, scene, camera, canvas }) => {
  // --- 外部アセット（Poly Haven / CC0。assets/polyhaven/CREDITS.md 参照） ---
  const gltfLoader = createGLTFLoader();
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

  /** 炎を包む箱。中身が倒れるのに合わせて、毎フレーム位置と大きさを変える */
  const flameBox = new Mesh();

  // --- 風 ---
  //
  // 風は「時刻だけの関数」にしてある。こうしておくと、上昇の遅れ（高さ h の空気は
  // τ = h/v 秒前に根元で受けた風になびいている）を、単に t - τ を渡すだけで表せる。
  // 和をそのまま使うと always-on の揺れになるので、しきい値で切って突風にする。
  // 静かな時間と吹く時間が交互に来て、周期が互いに素なので見た目には繰り返さない。
  const windAngle = (t: number) => 2.1 * Math.sin(t * 0.11) + 1.3 * Math.sin(t * 0.19 + 2.2);
  const windBurst = (t: number) => {
    const raw = 0.55 * Math.sin(t * 0.31) + 0.3 * Math.sin(t * 0.73 + 1.3) + 0.15 * Math.sin(t * 1.7 + 2.9);
    const eased = Math.max(0, (raw - 0.06) / 0.94);
    // 立ち上がりを鋭くして吹き始めを突風らしくする。ただし二乗まで効かせると
    // 中くらいの風がほとんど潰れてしまい、たまに少し揺れるだけの炎になる
    return Math.pow(eased, 1.3);
  };
  /** プルームが炎の高さを昇りきるまでの時間 */
  const WIND_DELAY = FLAME_HEIGHT / PLUME_SPEED;
  /** 根元から穂先まで、遅れをずらした風。シェーダーは高さで補間するだけでよい */
  const windTaps = Array.from({ length: WIND_TAPS }, () => uniform(new Vector2()));
  /** いまの突風の強さ。炎の丈・明るさ・灯りに効かせる */
  const gustStrength = uniform(0);

  const updateWind = (elapsed: number) => {
    // 倒れた炎がはみ出さないよう、各段の横ずれから箱を取り直す
    let leftX = 0;
    let rightX = 0;
    let backZ = 0;
    let frontZ = 0;

    for (let i = 0; i < WIND_TAPS; i += 1) {
      const t = elapsed - (WIND_DELAY * i) / (WIND_TAPS - 1);
      const strength = windBurst(t);
      const angle = windAngle(t);
      windTaps[i].value.set(Math.cos(angle) * strength, Math.sin(angle) * strength);

      const height = i / (WIND_TAPS - 1);
      const bend = Math.pow(height, WIND_BEND_POWER) * WIND_BEND;
      const offsetX = windTaps[i].value.x * bend;
      const offsetZ = windTaps[i].value.y * bend;
      leftX = Math.min(leftX, offsetX);
      rightX = Math.max(rightX, offsetX);
      backZ = Math.min(backZ, offsetZ);
      frontZ = Math.max(frontZ, offsetZ);
    }

    gustStrength.value = windBurst(elapsed);

    boxMin.value.set(leftX - BOX_RADIUS, BOX_BOTTOM, backZ - BOX_RADIUS);
    boxMax.value.set(rightX + BOX_RADIUS, BOX_TOP, frontZ + BOX_RADIUS);
    flameBox.position.set(
      (boxMin.value.x + boxMax.value.x) / 2,
      (BOX_BOTTOM + BOX_TOP) / 2,
      (boxMin.value.z + boxMax.value.z) / 2
    );
    flameBox.scale.set(
      boxMax.value.x - boxMin.value.x,
      BOX_TOP - BOX_BOTTOM,
      boxMax.value.z - boxMin.value.z
    );
  };

  // --- 火の粉（ここだけ粒子。炎と違って、本当に離散した炭素の粒なので） ---
  const positionBuffer = instancedArray(EMBER_COUNT, 'vec3');
  const velocityBuffer = instancedArray(EMBER_COUNT, 'vec3');
  const lifeBuffer = instancedArray(EMBER_COUNT, 'float'); // 残り寿命 1 → 0
  const seedBuffer = instancedArray(EMBER_COUNT, 'float'); // 粒子ごとの個体差 0..1

  const computeInit = Fn(() => {
    const id = instanceIndex.toFloat();
    seedBuffer.element(instanceIndex).assign(rand(vec2(id.mul(0.0013), 7.31)));

    const angle = rand(vec2(id.mul(0.0007), 1.13)).mul(Math.PI * 2);
    const radius = rand(vec2(id.mul(0.0011), 3.71)).sqrt().mul(BASE_RADIUS);
    positionBuffer
      .element(instanceIndex)
      .assign(
        vec3(
          cos(angle).mul(radius),
          rand(vec2(id.mul(0.0017), 5.11)).mul(FLAME_HEIGHT),
          sin(angle).mul(radius)
        )
      );
    velocityBuffer.element(instanceIndex).assign(vec3(0));
    // 初期状態から散らばっているよう、寿命をばらけさせておく
    lifeBuffer.element(instanceIndex).assign(rand(vec2(id.mul(0.0019), 9.53)));
  })().compute(EMBER_COUNT);

  const computeUpdate = Fn(() => {
    const position = positionBuffer.element(instanceIndex);
    const velocity = velocityBuffer.element(instanceIndex);
    const life = lifeBuffer.element(instanceIndex);
    const seed = seedBuffer.element(instanceIndex);

    const dt = deltaTime.min(1 / 30);

    /** 粒子ごと・再生成ごとに変わる乱数 */
    const noiseFor = (salt: number) => rand(vec2(seed.mul(91.7).add(salt), time.mul(0.37).add(salt * 1.7)));

    // 火の粉は上昇気流に乗って舞い上がり、離れるほど流れが弱くなって漂う
    const turbulence = mx_fractal_noise_vec3(
      position.mul(vec3(1.5, 0.9, 1.5)).add(vec3(0, time.mul(-1.5), 0)).add(seed.mul(19.0)),
      3,
      2.0,
      0.5,
      1.0
    );
    const rise = smoothstep(0.0, FLAME_HEIGHT, position.y);
    // 火の粉は軽いので、突風にはっきり流される
    const acceleration = vec3(
      turbulence.x.mul(3.4).sub(position.x.mul(0.9)).add(windTaps[0].x.mul(14.0)),
      mix(float(5.4), float(1.1), rise),
      turbulence.z.mul(3.4).sub(position.z.mul(0.9)).add(windTaps[0].y.mul(14.0))
    );

    velocity.addAssign(acceleration.mul(dt));
    velocity.mulAssign(float(1.0).sub(dt.mul(1.6))); // 空気抵抗
    position.addAssign(velocity.mul(dt));

    life.subAssign(dt.mul(float(0.34).mul(seed.mul(0.5).add(0.75))));

    If(life.lessThanEqual(0.0), () => {
      const angle = noiseFor(0.21).mul(Math.PI * 2);
      const radius = noiseFor(0.43).sqrt().mul(BASE_RADIUS * 0.8);
      position.assign(vec3(cos(angle).mul(radius), noiseFor(0.67).mul(0.3), sin(angle).mul(radius)));
      velocity.assign(vec3(0, noiseFor(0.89).mul(1.4).add(1.2), 0));
      life.assign(1.0);
    });
  })().compute(EMBER_COUNT);

  renderer.computeAsync(computeInit);

  // --- 火の粉の描画 ---
  const life = lifeBuffer.toAttribute();
  const seed = seedBuffer.toAttribute();

  // 炎から飛び出した炭素の粒。冷えながら 1320K → 780K まで落ちる
  const emberTemperature = mix(float(780), float(1320), smoothstep(0.0, 0.9, life));
  // 回転しながら飛ぶので、見かけの面積が変わって明滅する
  const twinkle = sin(time.mul(24.0).add(seed.mul(120.0))).mul(0.4).add(0.75);
  const emberColor = blackbodyColor(emberTemperature)
    .mul(pow(emberTemperature.div(1400.0), 4.0))
    .mul(twinkle)
    .mul(3.4);

  const falloff = smoothstep(0.5, 0.05, uv().sub(0.5).length());
  const emberAlpha = falloff.mul(smoothstep(0.0, 0.25, life)).mul(0.32);

  const emberMaterial = new SpriteNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false
  });
  emberMaterial.positionNode = positionBuffer.toAttribute();
  const emberSize = float(0.018).mul(mix(float(1.1), float(0.5), life));
  emberMaterial.scaleNode = vec2(emberSize, emberSize);
  emberMaterial.colorNode = vec4(emberColor, emberAlpha);

  const embers = new Sprite(emberMaterial);
  embers.count = EMBER_COUNT;
  embers.frustumCulled = false;
  scene.add(embers);

  // --- 炎（発光する参加媒質としてレイマーチする） ---
  //
  // 粒子で描くのをやめた理由。拡散炎が光るのは燃料と空気が出会う「面」の上だけで、
  // 実際の炎は乱流に折り畳まれた薄い膜の集まりに見える。粒子はその面を離散的に
  // 拾うことしかできないので、どこまで数を増やしても点の集まりのままだった。
  // 面そのものを積分すれば、リボンとして繋がって見える。
  const boxMin = uniform(new Vector3(-BOX_RADIUS, BOX_BOTTOM, -BOX_RADIUS));
  const boxMax = uniform(new Vector3(BOX_RADIUS, BOX_TOP, BOX_RADIUS));

  // 箱の「前面」を描く。背面だとフラグメントの深度が薪よりずっと奥になり、
  // 薪が手前にあるピクセルで炎が丸ごと消えてしまう（薪を舐める炎まで巻き添えになる）。
  // かといって深度テストを切ると、地面の下の炎まで岩越しに透けて見える。
  // 前面なら深度は箱の手前になるので、薪は炎を隠さず、手前の岩はきちんと隠す。
  // カメラは minDistance の制限で箱の中に入れないので、前面は必ず存在する
  const flameMaterial = new MeshBasicNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    fog: false
  });

  flameMaterial.colorNode = Fn(() => {
    const rayOrigin = cameraPosition;
    const rayDirection = normalize(positionWorld.sub(cameraPosition));

    // 前面を描いているので、入るところはこのフラグメント自身。
    // 出るところは箱との遠い側の交点をスラブ法で求める
    const inverse = vec3(1.0).div(rayDirection.add(vec3(1e-6)));
    const t0 = boxMin.sub(rayOrigin).mul(inverse);
    const t1 = boxMax.sub(rayOrigin).mul(inverse);
    const farHit = max(t0, t1);
    const enter = positionWorld.distance(rayOrigin);
    const exit = min(min(farHit.x, farHit.y), farHit.z);
    const stepSize = max(exit.sub(enter), 0.0).div(STEPS);

    // 一定間隔だと縞が出るので、画面座標でサンプル位置をずらす
    const jitter = rand(screenUV.mul(vec2(443.7, 917.3)).add(time));

    const radiance = vec3(0).toVar();
    const transmittance = float(1).toVar();

    Loop(STEPS, ({ i }: { i: TSLNode }) => {
      If(transmittance.lessThan(0.02), () => {
        Break();
      });

      const distance = enter.add(stepSize.mul(float(i).add(jitter)));
      const point = rayOrigin.add(rayDirection.mul(distance));
      // 突風は酸素を送り込むので、炎はわずかに伸びる
      const height = clamp(
        point.y.div(float(FLAME_HEIGHT).mul(float(1.0).add(gustStrength.mul(0.25)))),
        0.0,
        1.4
      );

      // その高さの空気が根元で受けた風を、遅れをずらした4点から補間して引く
      const windLevel = clamp(height, 0.0, 1.0).mul(WIND_TAPS - 1);
      const wind01 = mix(windTaps[0], windTaps[1], clamp(windLevel, 0.0, 1.0));
      const wind12 = mix(wind01, windTaps[2], clamp(windLevel.sub(1.0), 0.0, 1.0));
      const wind = mix(wind12, windTaps[3], clamp(windLevel.sub(2.0), 0.0, 1.0));
      // 横へのずれは滞空時間ぶん積み上がるので、高さとともに大きくなる
      const bend = wind.mul(WIND_BEND).mul(pow(clamp(height, 0.0, 1.0), WIND_BEND_POWER));

      // なびき。炎はプルームなので、高さ y の位置は根元が y/v 秒前にした動きをなぞる。
      // この遅れが無いと、棒が振り子のように振れるだけの動きになる
      const delayed = time.sub(point.y.div(PLUME_SPEED));
      const sway = vec2(
        sin(delayed.mul(1.31)).mul(0.15).add(sin(delayed.mul(3.02).add(1.3)).mul(0.07)),
        cos(delayed.mul(1.14)).mul(0.13).add(cos(delayed.mul(2.61).add(2.1)).mul(0.06))
      ).mul(pow(height, 1.6));
      const axis = point.xz.sub(sway).sub(bend);
      const radius = axis.length();

      // 渦輪が根元から穂先へ抜けていく。f ≈ 1.5/sqrt(D) から 1.7Hz。
      // 位相は根元ごとに（結合の遅れぶんだけ）ずらして使う
      const puffPhase = time.mul(PUFF_HZ).sub(height.mul(VORTEX_WAVES)).mul(Math.PI * 2);

      // 輪郭の凹凸。滑らかな回転体のままだと、どうしてもロウソクの穂先に見えてしまう。
      // 方位（単位ベクトルの成分で代用。atan を使わずに済む）と高さで波打たせ、
      // それを上へ流すことで、舌が伸び縮みしながら昇っていく形になる
      const direction = axis.div(max(radius, 0.0001));
      const ragged = sin(direction.x.mul(4.1).add(point.y.mul(2.3)).sub(time.mul(3.1)))
        .mul(0.17)
        .add(sin(direction.y.mul(5.3).sub(point.y.mul(1.7)).add(time.mul(2.2))).mul(0.12))
        .add(sin(direction.x.mul(2.2).add(direction.y.mul(3.1)).add(point.y.mul(3.4)).sub(time.mul(4.3))).mul(0.09))
        .mul(float(1.0).add(gustStrength.mul(0.7)));

      // 薪ごとに立つ火。互いに影響し合うので、上へ行くほど寄り集まって背が伸びる
      const convergence = smoothstep(0.0, MERGE_HEIGHT, height);
      const spacing = mix(float(1.0), float(MERGE_SHRINK), convergence);
      const merged = float(1.0).add(convergence.mul(MERGE_LIFT));

      let roots: TSLNode = float(0.0);
      for (const root of FLAME_ROOTS) {
        // 引き寄せ合って重心へ寄る
        const center = vec2(ROOT_CENTROID[0], ROOT_CENTROID[1]).add(
          vec2(root.offsetX, root.offsetZ).mul(spacing)
        );
        const local = axis.sub(center);
        // 合流したぶん背が伸びる
        const localHeight = height.div(float(root.heightScale).mul(merged));
        const localPuff = sin(puffPhase.add(root.phase)).mul(smoothstep(0.05, 0.6, localHeight)).mul(0.2);
        const rootRadius = float(ROOT_RADIUS * root.strength)
          .mul(pow(max(float(1.0).sub(localHeight), 0.0), 0.45))
          .mul(float(1.0).add(localPuff).add(ragged));
        roots = max(roots, smoothstep(1.0, 0.5, local.length().div(max(rootRadius, 0.015))));
      }

      // 上のプルームを別に用意してフェードインさせてはいけない。
      // 合流して細くなった柱より太いものが途中から現れるので、そこが膨らみになる。
      // 合流した根元そのものが、そのままプルームになるのが正しい。
      // 背の高い火だけが上まで残るので、先端は自然に細って千切れる
      const envelope = roots;

      const density = float(0).toVar();
      const temperature = float(1000).toVar();

      // 外形の外ではノイズを引かない。箱は炎よりずっと大きいので、これが一番効く
      If(envelope.greaterThan(0.002), () => {
        // 乱流に折り畳まれた炎面。ノイズ場を上へ流し、そのゼロ等値面の近くだけを光らせる
        const advected = vec3(axis.x, point.y.sub(time.mul(PLUME_SPEED)), axis.y);
        const coarse = mx_noise_float(advected.mul(vec3(4.4, 1.7, 4.4)));
        const fine = mx_noise_float(advected.mul(vec3(9.5, 4.0, 9.5)).add(11.0));
        const sheet = smoothstep(0.36, 0.02, abs(coarse.add(fine.mul(0.4))));

        // 根元は炎が密で連続しているので、膜が見えてくるのは少し上から
        // 地面より下に炎は無い。ここを切らないと、箱の底が明るい板として見えてしまう
        // 薪の高さ（0.03〜0.21）より下からは炎を出さない。低いところに残すと、
        // 手前の岩との境界で箱の切り口が明るい塊として見えてしまう
        const foot = smoothstep(0.06, 0.26, point.y);
        density.assign(envelope.mul(mix(float(1.0), sheet, smoothstep(0.0, 0.06, height))).mul(foot));
        // 薪のすぐ上が最も高温で、上るほど冷える
        temperature.assign(mix(float(1780), float(980), pow(height, 0.72)).add(gustStrength.mul(90.0)));
      });

      // 黒体放射。明るさは T^4（Stefan–Boltzmann）で効く
      const emission = blackbodyColor(temperature)
        .mul(pow(temperature.div(1400.0), 4.0))
        .mul(density)
        .mul(21.0);

      radiance.addAssign(emission.mul(transmittance).mul(stepSize));
      // 煤による自己吸収。奥の膜がわずかに隠れる
      transmittance.mulAssign(exp(density.mul(stepSize).mul(-1.4)));
    });

    return vec4(radiance, 1.0);
  })();

  // 単位立方体。大きさと位置は updateWind が毎フレーム合わせる
  flameBox.geometry = new BoxGeometry(1, 1, 1);
  flameBox.material = flameMaterial;
  flameBox.renderOrder = 10;
  flameBox.frustumCulled = false;
  scene.add(flameBox);
  updateWind(0);

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

  // 薪。炎の根元（FLAME_ROOTS）はこの位置に合わせてある
  const firewood = firewoodGltf.scene.children.slice();
  FIREWOOD.forEach(([dx, dz, y, yaw, scale], index) => {
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
  renderPipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.28, 0.7, 0.9));

  return {
    update: (elapsed) => {
      controls.update();
      renderer.compute(computeUpdate);

      updateWind(elapsed);

      // 焚き火の照り返しの揺らぎ（CPU側の簡易ノイズ）。突風のときは酸素が入って明るくなる
      const flicker =
        Math.sin(elapsed * 7.3) * 0.5 + Math.sin(elapsed * 13.7) * 0.3 + Math.sin(elapsed * 23.1) * 0.2;
      const gust = gustStrength.value;
      fireLight.intensity = 15 + flicker * 4.6 + gust * 5.5;
      fireLight.position.x = Math.sin(elapsed * 3.1) * 0.05 + windTaps[0].value.x * 0.22;
      fireLight.position.z = Math.cos(elapsed * 2.7) * 0.05 + windTaps[0].value.y * 0.22;
      lightColor.setHSL(0.075 + flicker * 0.006, 0.7, 0.56);
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
  const t = useText();
  return (
    <WebGPUCanvas
      title={t('炎の揺らぎ', 'Flame')}
      hint={t(
        <>
          炎を発光する媒質としてレイマーチし、火の粉だけを粒子で飛ばしています。
          <br />
          色は黒体放射、脈動は 1.7Hz の渦輪、風はランダムな突風。
          <br />
          ドラッグで回転、スクロールでズーム。
        </>,
        <>
          The flame is ray-marched as an emissive medium; only the embers are particles.
          <br />
          Colour comes from black-body radiation, the pulsing from 1.7 Hz vortex rings, and the sway
          from random gusts.
          <br />
          Drag to orbit, scroll to zoom.
        </>
      )}
      setup={memoizedSetup}
    />
  );
};

export default Flame;
