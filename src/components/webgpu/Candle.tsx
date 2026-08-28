import React, { MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BoxGeometry,
  Color,
  CylinderGeometry,
  Fog,
  LatheGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  PointLight,
  RenderPipeline,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three/webgpu';
import {
  Fn,
  Loop,
  cameraPosition,
  clamp,
  color,
  cos,
  exp,
  float,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  pass,
  positionWorld,
  pow,
  rand,
  screenUV,
  sin,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import WebGPUCanvas, { SceneSetup } from './WebGPUCanvas';
import { useText } from '../../i18n';
import { blackbodyColor } from './blackbody';

/**
 * ロウソクの火。
 *
 * 粒子では描かない。実際の炎は煤の粒子（〜100nm）が 10^10 個/cm3 の密度で光る
 * 連続体なので、スプライトを重ねるとどうしても粒状感が残る。ここでは炎を
 * **発光する参加媒質**として扱い、カメラからのレイを積分している
 * （Nguyen, Fedkiw & Jensen, SIGGRAPH 2002 / Pegoraro & Parker, EGWNP 2006 と同じ立場）。
 *
 * 燃焼工学の知見をそのまま実装に落としている点が4つある。
 *
 * 1. **色は黒体放射から出す。** ロウソクの黄色は炎の色ではなく、1100〜1900K に熱せられた
 *    煤の熱放射。温度場を置いて Planck の式（の色温度近似）から RGB を引いている。
 *    先端が白いのは白い色があるのではなく、そこが最も高温で明るく、
 *    トーンマッピングが飽和した結果として出てくる。
 * 2. **根元の青は熱放射ではない。** CH*(431nm) と C2* のスワンバンド(473/516nm)による
 *    化学発光で、煤ができる前の反応帯にだけ現れる。だから薄い殻として別に足している。
 * 3. **1本のロウソクは「ちらつく」状態にない。** 浮力が生む Kelvin-Helmholtz 型の不安定性
 *    （Buckmaster & Peters 1986 "The infinite candle and its stability"）による 9〜13Hz の
 *    自励振動は、臨界サイズを超えた炎——ロウソクなら3本以上を束ねて炎が融合した場合——に
 *    現れるもので、1本の炎の振動は過渡的にしか起きない。だから常時 11Hz で震わせるのは
 *    regime の取り違えになる。ここでは 11Hz 成分はごく弱い残差として置き、
 *    息を吹きかけて乱したときだけ立ち上がるようにしている。
 * 4. **静穏時に見えている動きは、部屋の空気による 0.1〜0.7Hz のゆっくりしたなびき。**
 *    しかも炎はプルームなので、高さ h の位置は根元が τ = h/v 秒前にした動きをなぞる
 *    （v ≒ 0.4m/s、炎全体の通過時間は 0.1 秒ほど。層流拡散炎の滞留時間 40〜300ms と整合）。
 *    この遅れを入れると、剛体が振り子のように振れるのではなく、S字が下から伝わる動きになる。
 *
 * 息を吹きかけると、その強さに応じて炎が傾き、ちらつき、強すぎると吹き消える。
 * 消えたあとは芯がしばらく赤熱し、白い煙がひとすじ立ちのぼる。
 */

/** 炎のおおよその高さ。形を決める各種しきい値の基準にする */
const FLAME_HEIGHT = 0.46;
/** 炎のいちばん太いところの半径の基準値（実際の最大は bulge × taper でこの 0.72 倍ほど） */
const FLAME_RADIUS = 0.068;
/** 乱されたときのちらつきの周波数[Hz]。束ねたロウソクの実測 9〜13Hz の帯域 */
const FLICKER_HZ = 11.2;
/** プルームの上昇速度[ワールド単位/秒]。1 単位 ≒ 10cm なので 0.4m/s 相当 */
const PLUME_SPEED = 4.0;
/** 炎の高さ方向に渦輪が何個乗るか。周波数と上昇速度から決まる（f × H / v） */
const VORTEX_WAVES = (FLICKER_HZ * FLAME_HEIGHT) / PLUME_SPEED;
/** 静穏時に残るくびれの深さ。1本の炎はほとんど震えない */
const RESIDUAL_FLICKER = 0.012;
/** 息で乱されたときに、そこへ上乗せされるくびれの深さ */
const DISTURBED_FLICKER = 0.13;

/** 消えたあとに立ちのぼる煙の高さ */
const SMOKE_HEIGHT = 0.55;

/** この強さを超えて息を吹きかけると、炎が芯から引き剥がされて消えはじめる */
const EXTINGUISH_BLOW = 0.55;

/** レイマーチのステップ数 */
const STEPS = 56;

/** 燭台の皿の高さ。ロウソクはこの上に立つ */
const DISH_TOP = 0.05;
/** ロウソク本体（ローカル座標）の、溶けた縁の高さ */
const WAX_TOP = 0.825;
/** ロウソクの半径。炎を主役にするため細身にしてある */
const WAX_RADIUS = 0.115;
/** 芯の先端のワールド高さ。炎はここから立ち上がる */
const WICK_TIP = DISH_TOP + 0.865;

/** 炎と煙を包む箱（この中だけをレイマーチする） */
const BOX_RADIUS = 0.16;
const BOX_BOTTOM = -0.05;
const BOX_TOP = 0.62;

/** TSL のノードは型が複雑なので、シェーダー組み立て用ヘルパーの引数はこの別名で受ける */
type TSLNode = any;

/** React 側とシーンのあいだで毎フレームやりとりする値 */
type CandleIO = {
  /** 0..1 の息の強さ。React 側（キー入力とマイク）が更新する */
  blow: number;
  /** シーン側が埋める。呼ぶと再点灯する */
  relight: (() => void) | null;
  /** シーン側から React へ、火が点いているかを知らせる */
  onLitChange: (lit: boolean) => void;
};

const createSetup =
  (io: MutableRefObject<CandleIO>): SceneSetup =>
  async ({ renderer, scene, camera, canvas }) => {
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;

    // 暗い部屋。灯りの届かないところは闇に溶ける
    scene.fog = new Fog(0x030406, 2.6, 9.0);

    camera.position.set(0.5, 1.16, 1.55);

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 0.92, 0);
    controls.enableDamping = true;
    controls.minDistance = 0.5;
    controls.maxDistance = 5;
    controls.maxPolarAngle = Math.PI * 0.52;
    controls.update();

    /** 息による横向きの流れ。向きはカメラのある側から炎へ */
    const gust = uniform(new Vector3(0, 0, 0));
    /** 炎の明るさの脈動。灯りとロウの透け具合を同じ値で動かす */
    const flicker = uniform(1);
    /** 炎がどれだけ乱されているか（0..1）。息で立ち上がり、数秒かけて収まる */
    const disturbance = uniform(0);
    /** 火が点いている度合い（0..1）。0 で消灯 */
    const ignition = uniform(1);
    /** 吹き消したあとの煙の濃さ（0..1） */
    const smokeAmount = uniform(0);
    /** 芯の赤熱。消したあともしばらく残る */
    const wickGlow = uniform(1);

    // --- 炎（発光する参加媒質としてレイマーチする） ---
    const flameOrigin = vec3(0, WICK_TIP, 0);
    const boxMin = vec3(-BOX_RADIUS, WICK_TIP + BOX_BOTTOM, -BOX_RADIUS);
    const boxMax = vec3(BOX_RADIUS, WICK_TIP + BOX_TOP, BOX_RADIUS);

    const flameMaterial = new MeshBasicNodeMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: BackSide,
      fog: false
    });

    flameMaterial.colorNode = Fn(() => {
      const rayOrigin = cameraPosition;
      const rayDirection = normalize(positionWorld.sub(cameraPosition));

      // 箱に入るところ。背面を描いているので、出るところはこのフラグメント自身
      const inverse = vec3(1.0).div(rayDirection.add(vec3(1e-6)));
      const t0 = boxMin.sub(rayOrigin).mul(inverse);
      const t1 = boxMax.sub(rayOrigin).mul(inverse);
      const near = min(t0, t1);
      const enter = max(max(max(near.x, near.y), near.z), 0.0);
      const exit = positionWorld.distance(rayOrigin);
      const stepSize = max(exit.sub(enter), 0.0).div(STEPS);

      // 一定間隔だと縞が出るので、画面座標でサンプル位置をずらす
      const jitter = rand(screenUV.mul(vec2(443.7, 917.3)).add(time));

      // 吹き消されかけた炎は縮む
      const flameScale = mix(float(0.32), float(1.0), ignition);

      const radiance = vec3(0).toVar();
      const transmittance = float(1).toVar();

      Loop(STEPS, ({ i }: { i: TSLNode }) => {
        const distance = enter.add(stepSize.mul(float(i).add(jitter)));
        const point = rayOrigin.add(rayDirection.mul(distance)).sub(flameOrigin);

        const height = point.y.div(float(FLAME_HEIGHT).mul(flameScale));

        // 部屋の空気によるなびき。炎はプルームなので、高さ h の位置は根元が
        // τ = h·H/v 秒前にした動きをなぞる。この遅れが無いと、剛体が振り子のように
        // 振れるだけの不自然な動きになる。
        const lean = pow(clamp(height, 0.0, 1.3), 1.5);
        const delayed = time.sub(clamp(height, 0.0, 1.3).mul(FLAME_HEIGHT / PLUME_SPEED));
        // 係数は rad/s。0.12Hz / 0.29Hz / 0.67Hz を重ねている（周期にして 8秒・3.4秒・1.5秒）
        const swayX = sin(delayed.mul(0.75).add(0.7))
          .mul(0.013)
          .add(sin(delayed.mul(1.82)).mul(0.009))
          .add(sin(delayed.mul(4.21).add(2.1)).mul(0.004));
        const swayZ = cos(delayed.mul(0.83).add(2.6))
          .mul(0.013)
          .add(cos(delayed.mul(1.67)).mul(0.009))
          .add(cos(delayed.mul(3.94).add(1.4)).mul(0.004));
        // 息はなびきよりずっと強く、根元に近いところから押し倒す
        // 係数は控えめに。全力の息（gust の長さ 3.4）でも 0.08 単位ほどで、
        // 炎の半径 0.05 と足しても箱（0.16）の中に収まる
        const pushed = pow(clamp(height, 0.0, 1.3), 1.1).mul(0.024);
        const axis = vec2(
          swayX.mul(lean).add(gust.x.mul(pushed)),
          swayZ.mul(lean).add(gust.z.mul(pushed))
        );
        const radial = point.xz.sub(axis);
        const radius = radial.length();

        // 渦輪の通過によるくびれ。1本のロウソクは臨界サイズ以下でほとんど震えないので、
        // 静穏時はごく浅い残差だけ。息を吹きかけて乱したときに本来の 11Hz が立ち上がる
        const flickerDepth = float(RESIDUAL_FLICKER).add(disturbance.mul(DISTURBED_FLICKER));
        const phase = time.mul(FLICKER_HZ).sub(height.mul(VORTEX_WAVES)).mul(Math.PI * 2);
        const vortex = sin(phase).mul(smoothstep(0.1, 0.65, height)).mul(flickerDepth);
        const tipPulse = sin(time.mul(FLICKER_HZ * Math.PI * 2).add(1.9))
          .mul(float(0.006).add(disturbance.mul(0.055)))
          .add(1.0);
        // 芯と溶けたロウの状態は数秒かけて変わるので、炎の丈もゆっくり伸び縮みする
        const breathe = sin(time.mul(0.9)).mul(0.035).add(sin(time.mul(1.63).add(1.9)).mul(0.022)).add(1.0);
        const normalizedHeight = height.div(tipPulse.mul(breathe));

        // 輪郭：根元は芯を包む程度 → 高さ3割で最大 → 先端まで直線的に絞る
        const bulge = mix(float(0.42), float(1.0), smoothstep(0.0, 0.28, normalizedHeight));
        const taper = pow(max(float(1.0).sub(normalizedHeight), 0.0), 0.85);
        // 強く吹かれると横に広がって千切れそうになる
        const spread = float(1.0).add(disturbance.mul(0.35));
        const flameRadius = max(
          float(FLAME_RADIUS).mul(bulge).mul(taper).mul(float(1.0).add(vortex)).mul(spread),
          0.0005
        );

        const radialFraction = clamp(radius.div(flameRadius), 0.0, 1.6);

        // 輪郭の内側。実際の炎の縁は驚くほど鋭いので、ぼかしは狭く
        const edge = smoothstep(1.0, 0.82, radialFraction);
        // 芯のすぐ上は、まだ燃えていない気体で光らない（炎心）
        const coneRadius = float(FLAME_RADIUS).mul(0.36).mul(smoothstep(0.3, 0.02, normalizedHeight));
        // coneRadius が 0 になる高さで smoothstep の両端が一致してしまうので、下駄を履かせておく
        const cone = smoothstep(coneRadius.mul(0.45), coneRadius.mul(1.3).add(0.0006), radius);
        const foot = smoothstep(-0.02, 0.06, height);
        // 先端より上には何も無い（これが無いと軸上に細い筋が伸びる）
        const crown = smoothstep(1.02, 0.94, normalizedHeight);
        // 煤の濃淡はプルームに乗って上へ流れる。静穏な炎ではほとんど見えないので浅く
        const ripple = mx_noise_float(
          vec3(radial.mul(22.0), point.y.mul(5.0).sub(time.mul(5.0 * PLUME_SPEED * 0.25)))
        )
          .mul(float(0.035).add(disturbance.mul(0.06)))
          .add(1.0);

        const density = edge.mul(cone).mul(foot).mul(crown).mul(ripple).mul(ignition);

        // 温度場。煤は上るほど熱くなり、炎面（外縁）に近いほど熱い。
        // ロウソクの実測はおおむね 芯の内側 900K 〜 炎面 1700K
        const temperature = mix(float(1120), float(1820), smoothstep(0.04, 0.78, normalizedHeight)).add(
          mix(float(-140), float(130), smoothstep(0.2, 0.92, radialFraction))
        );

        // 黒体放射。明るさは T^4（Stefan–Boltzmann）で効くので、根元と先端で 10 倍以上違う
        const emission = blackbodyColor(temperature)
          .mul(pow(temperature.div(1700.0), 4.0))
          .mul(density)
          .mul(110.0);

        // 化学発光の青い殻。反応帯のうち、まだ煤ができていない根元側にだけ出る
        const sheet = exp(pow(radius.sub(flameRadius).div(0.02), 2.0).negate());
        const chemiluminescence = vec3(0.16, 0.42, 1.0)
          .mul(sheet.mul(smoothstep(0.26, 0.0, normalizedHeight)).mul(foot).mul(ignition))
          .mul(1.2);

        // 吹き消した直後だけ、芯から白い煙がひとすじ立ちのぼる
        const smokeHeight = clamp(point.y.div(SMOKE_HEIGHT), 0.0, 1.0);
        const smokeSway = vec2(
          sin(time.mul(1.1).add(point.y.mul(7.0))).mul(0.03),
          cos(time.mul(0.87).add(point.y.mul(6.0))).mul(0.03)
        ).mul(pow(smokeHeight, 1.5));
        const smokeOffset = point.xz.sub(smokeSway);
        const smokeRadius = float(0.008).add(smokeHeight.mul(0.05));
        const wisp = mx_noise_float(vec3(smokeOffset.mul(26.0), point.y.mul(6.0).sub(time.mul(3.4))))
          .mul(0.5)
          .add(0.55);
        const smokeDensity = smoothstep(1.0, 0.25, smokeOffset.length().div(smokeRadius))
          .mul(smoothstep(0.0, 0.06, smokeHeight))
          .mul(smoothstep(1.0, 0.4, smokeHeight))
          .mul(wisp)
          .mul(smokeAmount);
        const smokeLight = vec3(0.34, 0.32, 0.3).mul(smokeDensity).mul(3.2);

        radiance.addAssign(emission.add(chemiluminescence).add(smokeLight).mul(transmittance).mul(stepSize));
        // 煤による自己吸収。奥側がわずかに隠れる
        transmittance.mulAssign(exp(density.add(smokeDensity).mul(stepSize).mul(-7.0)));
      });

      return vec4(radiance, 1.0);
    })();

    const flame = new Mesh(
      new BoxGeometry(BOX_RADIUS * 2, BOX_TOP - BOX_BOTTOM, BOX_RADIUS * 2),
      flameMaterial
    );
    flame.position.set(0, WICK_TIP + (BOX_TOP + BOX_BOTTOM) / 2, 0);
    flame.renderOrder = 10;
    scene.add(flame);

    // --- ロウソク本体 ---

    /** ロウが炎に照らされて透ける具合。上ほど、また芯に近いほど明るい */
    const waxMaterial = new MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0 });
    {
      const grain = mx_fractal_noise_float(
        vec3(positionWorld.xz.mul(9.0), positionWorld.y.mul(2.2)),
        3,
        2.0,
        0.5,
        1.0
      )
        .mul(0.5)
        .add(0.5);
      waxMaterial.colorNode = mix(color(0xe8dcc0), color(0xfbf3e2), grain);
      waxMaterial.roughnessNode = mix(float(0.5), float(0.28), grain);
      // 溶けた縁のあたりは薄いので、炎の光が向こう側から透ける
      const through = smoothstep(0.6, DISH_TOP + WAX_TOP, positionWorld.y);
      waxMaterial.emissiveNode = mix(color(0xff7a1e), color(0xffca7a), grain)
        .mul(through.mul(through).mul(through))
        .mul(flicker)
        .mul(ignition)
        .mul(0.55);
    }

    // ロウソクの断面。上端は溶けて窪ませる
    const profile = [
      new Vector2(0.0, 0.0),
      new Vector2(WAX_RADIUS, 0.0),
      new Vector2(WAX_RADIUS, 0.62),
      new Vector2(WAX_RADIUS * 1.01, 0.74),
      new Vector2(WAX_RADIUS * 0.98, 0.8),
      new Vector2(WAX_RADIUS * 0.87, WAX_TOP),
      new Vector2(WAX_RADIUS * 0.58, 0.796),
      new Vector2(WAX_RADIUS * 0.26, 0.782),
      new Vector2(0.0, 0.778)
    ];
    const candleGeometry = new LatheGeometry(profile, 72);
    {
      // 旋盤形状のままだと完全な回転対称で作り物に見えるので、溶けた上部を歪ませる
      const position = candleGeometry.attributes.position;
      const vertex = new Vector3();
      for (let i = 0; i < position.count; i += 1) {
        vertex.fromBufferAttribute(position, i);
        const radius = Math.hypot(vertex.x, vertex.z);
        if (radius < 1e-4) continue;
        const angle = Math.atan2(vertex.z, vertex.x);
        const melt = Math.max(0, (vertex.y - 0.58) / 0.25);
        const wobble =
          Math.sin(angle * 3 + 0.7) * 0.5 + Math.sin(angle * 5 - 1.3) * 0.3 + Math.sin(angle * 8 + 2.1) * 0.2;
        const scale = 1 + wobble * 0.07 * melt;
        position.setX(i, vertex.x * scale);
        position.setZ(i, vertex.z * scale);
        position.setY(i, vertex.y + wobble * 0.02 * melt);
      }
      candleGeometry.computeVertexNormals();
    }
    const candle = new Mesh(candleGeometry, waxMaterial);
    candle.position.y = DISH_TOP;
    scene.add(candle);

    // 側面を流れ落ちたロウの垂れ
    ([
      // [向き, 長さ, 太さ]
      [0.55, 0.34, 1.0],
      [2.35, 0.19, 0.8],
      [4.28, 0.27, 0.9],
      [5.4, 0.13, 0.7]
    ] as const).forEach(([angle, length, thickness]) => {
      const drip = new Mesh(new SphereGeometry(0.021, 18, 12), waxMaterial);
      drip.position.set(
        Math.cos(angle) * WAX_RADIUS * 0.98,
        DISH_TOP + 0.8 - length * 0.5,
        Math.sin(angle) * WAX_RADIUS * 0.98
      );
      drip.scale.set(thickness, length / 0.042, thickness * 0.62);
      scene.add(drip);
    });

    // 芯。根元は白く、炎に呑まれた先端は炭化して黒い
    const wickMaterial = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    {
      const charred = smoothstep(DISH_TOP + 0.79, DISH_TOP + 0.85, positionWorld.y);
      wickMaterial.colorNode = mix(color(0x9a8c74), color(0x100c0a), charred);
      // 炎に沈んでいる部分は熱で赤熱している。吹き消したあともしばらく残り火が見える
      wickMaterial.emissiveNode = color(0xff4a08).mul(charred.mul(flicker).mul(wickGlow).mul(1.1));
    }
    const wick = new Mesh(new CylinderGeometry(0.006, 0.011, 0.1, 10), wickMaterial);
    wick.position.set(0.004, DISH_TOP + 0.815, 0.002);
    wick.rotation.z = 0.12;
    scene.add(wick);

    // --- 燭台と机 ---
    const brassMaterial = new MeshStandardNodeMaterial({ roughness: 0.3, metalness: 1 });
    brassMaterial.colorNode = color(0xb08a46);
    const dish = new Mesh(
      new LatheGeometry(
        [
          new Vector2(0.0, 0.0),
          new Vector2(0.24, 0.0),
          new Vector2(0.27, 0.012),
          new Vector2(0.285, DISH_TOP),
          new Vector2(0.255, DISH_TOP * 0.86),
          new Vector2(0.135, 0.022),
          new Vector2(0.125, DISH_TOP),
          new Vector2(0.0, DISH_TOP)
        ],
        64
      ),
      brassMaterial
    );
    scene.add(dish);

    const tableMaterial = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 });
    {
      // 木目：Z 方向に細かく、X 方向に緩やかなノイズを引き伸ばす
      const grain = mx_fractal_noise_float(vec3(positionWorld.x.mul(0.9), positionWorld.z.mul(16.0), 0.0), 4, 2.0, 0.5, 1.0)
        .mul(0.5)
        .add(0.5);
      const wood = mix(color(0x241608), color(0x4d3418), grain);
      tableMaterial.colorNode = wood;
      tableMaterial.roughnessNode = float(0.62).sub(grain.mul(0.12));
    }
    const table = new Mesh(new PlaneGeometry(24, 24), tableMaterial);
    table.rotation.x = -Math.PI / 2;
    scene.add(table);

    // 背後の壁。灯りが届く範囲だけ浮かび上がる
    const wallMaterial = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    {
      const plaster = mx_fractal_noise_float(vec3(positionWorld.xy.mul(6.0), 0.0), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
      wallMaterial.colorNode = mix(color(0x1b1712), color(0x2c261d), plaster);
    }
    const wall = new Mesh(new PlaneGeometry(12, 7), wallMaterial);
    wall.position.set(0, 3.5, -1.6);
    scene.add(wall);

    // --- 灯り ---
    const candleLight = new PointLight(0xffa64a, 0.55, 6, 2);
    candleLight.position.set(0, WICK_TIP + 0.12, 0);
    scene.add(candleLight);
    scene.add(new AmbientLight(0x0c1220, 2.4));

    const lightColor = new Color();

    /** 暗順応。消灯すると光源が無くなって何も見えなくなるので、露出をゆっくり上げる */
    const EXPOSURE_LIT = 0.9;
    const EXPOSURE_DARK = 2.4;
    let exposure = EXPOSURE_LIT;

    // --- 火の状態 ---
    let lit = true;
    let ignitionValue = 1;
    let smokeValue = 0;
    let wickGlowValue = 1;

    const blowDirection = new Vector3();
    /** カメラのある側から炎へ向かう水平な向き */
    const updateBlowDirection = () => {
      blowDirection.set(0, WICK_TIP, 0).sub(camera.position);
      blowDirection.y = 0;
      if (blowDirection.lengthSq() < 1e-6) blowDirection.set(0, 0, -1);
      blowDirection.normalize();
    };
    const blowTarget = new Vector3();

    io.current.relight = () => {
      if (lit) return;
      lit = true;
      // 芯に火が移るところから始める
      ignitionValue = 0.08;
      io.current.onLitChange(true);
    };

    // --- ポストエフェクト（炎とロウの透けが滲むように） ---
    const renderPipeline = new RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode('output');
    renderPipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.25, 0.6, 0.85));

    return {
      update: (elapsed, delta) => {
        controls.update();

        const blow = Math.min(Math.max(io.current.blow, 0), 1);

        // 息の向きと強さ。立ち上がりは速く、やむのも速い
        updateBlowDirection();
        blowTarget.copy(blowDirection).multiplyScalar(blow * 3.4);
        gust.value.lerp(blowTarget, Math.min(1, delta * 9));

        // 乱れは息よりゆっくり収まる（吹くのをやめてもしばらく揺れている）
        disturbance.value = Math.max(blow, disturbance.value - delta * 0.7);

        if (lit) {
          if (blow > EXTINGUISH_BLOW) {
            // 強すぎる流れは炎を芯から引き剥がす
            ignitionValue -= ((blow - EXTINGUISH_BLOW) / (1 - EXTINGUISH_BLOW)) * 2.6 * delta;
          } else {
            ignitionValue = Math.min(1, ignitionValue + delta * 1.1);
          }
          if (ignitionValue <= 0) {
            ignitionValue = 0;
            lit = false;
            smokeValue = 1;
            io.current.onLitChange(false);
          } else {
            wickGlowValue = Math.min(1, wickGlowValue + delta * 2.0);
            smokeValue = Math.max(0, smokeValue - delta * 1.4);
          }
        } else {
          smokeValue = Math.max(0, smokeValue - delta * 0.3);
          wickGlowValue = Math.max(0, wickGlowValue - delta * 0.26);
        }

        ignition.value = ignitionValue;
        smokeAmount.value = smokeValue;
        wickGlow.value = wickGlowValue;

        // 静穏時の明るさの変化はゆっくり。速い成分は乱されたときだけ乗る
        const wander =
          Math.sin(elapsed * 1.1) * 0.5 + Math.sin(elapsed * 2.23 + 1.1) * 0.3 + Math.sin(elapsed * 4.31 + 2.7) * 0.2;
        const pulse = Math.sin(elapsed * FLICKER_HZ * Math.PI * 2) * disturbance.value;

        flicker.value = 1 + wander * 0.06 + pulse * 0.14;
        candleLight.intensity = (0.56 + wander * 0.05 + pulse * 0.1) * ignitionValue;
        candleLight.position.x = gust.value.x * 0.02;
        candleLight.position.z = gust.value.z * 0.02;
        lightColor.setHSL(0.085 + wander * 0.004, 0.72, 0.58);
        candleLight.color.copy(lightColor);

        // 目が暗さに慣れるまでの時定数はおよそ 1.5 秒
        const targetExposure = EXPOSURE_LIT + (EXPOSURE_DARK - EXPOSURE_LIT) * (1 - ignitionValue);
        exposure += (targetExposure - exposure) * Math.min(1, delta * 0.7);
        renderer.toneMappingExposure = exposure;
      },
      render: () => {
        renderPipeline.render();
      },
      dispose: () => {
        io.current.relight = null;
        controls.dispose();
      }
    };
  };

/** 息の音を拾う帯域。息は低いほうに偏った広帯域雑音になる */
const BLOW_LOW_HZ = 80;
const BLOW_HIGH_HZ = 600;
const BLOW_TOTAL_HZ = 4000;

/** 計測値を1行ぶん。ラベル・現在値・直近のピーク */
const Row: React.FC<{ label: string; value: string; peak: string; highlight?: boolean }> = ({
  label,
  value,
  peak,
  highlight
}) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, color: highlight ? '#ffd28a' : undefined }}>
    <span style={{ opacity: highlight ? 0.9 : 0.65 }}>{label}</span>
    <span>
      {value}
      <span style={{ opacity: 0.45, marginLeft: 10 }}>{peak}</span>
    </span>
  </div>
);

type MicState = 'off' | 'requesting' | 'on' | 'denied';

/** マイクから取れている値。しきい値を詰めるために画面に出している */
type MicMetrics = {
  /** 低域（80〜600Hz）のエネルギー[dB] */
  decibel: number;
  /** 低域が全体（〜4kHz）に占める割合 */
  ratio: number;
  /** 音量から作った 0..1（比率ゲートを掛ける前） */
  loudness: number;
  /** 低域の偏りによるゲート 0..1 */
  gate: number;
  /** 最終的な息の強さ */
  blow: number;
};

const EMPTY_METRICS: MicMetrics = { decibel: -120, ratio: 0, loudness: 0, gate: 0, blow: 0 };

const Candle: React.FC = () => {
  const t = useText();
  const [lit, setLit] = useState(true);
  const [micState, setMicState] = useState<MicState>('off');
  const [level, setLevel] = useState(0);

  const keyBlow = useRef(0);
  const micBlow = useRef(0);
  const metrics = useRef<MicMetrics>({ ...EMPTY_METRICS });
  const peak = useRef<MicMetrics>({ ...EMPTY_METRICS });
  const [readout, setReadout] = useState<{ now: MicMetrics; peak: MicMetrics } | null>(null);

  const io = useRef<CandleIO>({
    blow: 0,
    relight: null,
    onLitChange: () => {}
  });
  io.current.onLitChange = setLit;

  const setup = useMemo(() => createSetup(io), []);

  // マイクを許可しなくても試せるよう、スペースキー長押しでも息を吹きかけられる。
  // 押し続けるほど強くなるので、そっと揺らすことも吹き消すこともできる
  useEffect(() => {
    let raf = 0;
    let pressedAt = 0;
    let pushedAt = 0;

    const tick = (now: number) => {
      if (pressedAt > 0) keyBlow.current = Math.min(1, (performance.now() - pressedAt) / 900);
      const blow = Math.max(keyBlow.current, micBlow.current);
      io.current.blow = blow;
      setLevel((previous) => (Math.abs(previous - blow) > 0.02 ? blow : previous));

      // ピークはゆっくり下がる。吹いてから画面を見るまでの間、値が残るように
      metrics.current.blow = blow;
      const p = peak.current;
      const m = metrics.current;
      p.decibel = Math.max(m.decibel, p.decibel - 0.08);
      p.ratio = Math.max(m.ratio, p.ratio - 0.004);
      p.loudness = Math.max(m.loudness, p.loudness - 0.004);
      p.gate = Math.max(m.gate, p.gate - 0.004);
      p.blow = Math.max(m.blow, p.blow - 0.004);

      // 毎フレーム再描画すると重いので 10 回/秒だけ
      if (now - pushedAt > 100) {
        pushedAt = now;
        setReadout({ now: { ...m }, peak: { ...p } });
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      event.preventDefault();
      pressedAt = performance.now();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      pressedAt = 0;
      keyBlow.current = 0;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const audio = useRef<{ context: AudioContext; stream: MediaStream; raf: number } | null>(null);

  useEffect(
    () => () => {
      if (!audio.current) return;
      cancelAnimationFrame(audio.current.raf);
      audio.current.stream.getTracks().forEach((track) => track.stop());
      void audio.current.context.close();
      audio.current = null;
    },
    []
  );

  const enableMicrophone = async () => {
    if (micState === 'on' || micState === 'requesting') return;
    setMicState('requesting');
    try {
      // 息の音は補正で消されてしまうので、ブラウザ側の加工はすべて切る
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);

      const bins = new Float32Array(analyser.frequencyBinCount);
      const hzPerBin = context.sampleRate / analyser.fftSize;
      const lowFrom = Math.max(1, Math.floor(BLOW_LOW_HZ / hzPerBin));
      const lowTo = Math.min(bins.length, Math.ceil(BLOW_HIGH_HZ / hzPerBin));
      const totalTo = Math.min(bins.length, Math.ceil(BLOW_TOTAL_HZ / hzPerBin));

      const measure = () => {
        analyser.getFloatFrequencyData(bins);
        let low = 0;
        let high = 0;
        for (let i = lowFrom; i < lowTo; i += 1) low += 10 ** (bins[i] / 10);
        for (let i = lowTo; i < totalTo; i += 1) high += 10 ** (bins[i] / 10);

        // 息は低い帯域に偏った広帯域雑音。話し声や環境音と切り分けるための条件
        const ratio = low + high > 0 ? low / (low + high) : 0;
        const decibel = 10 * Math.log10(low + 1e-12);
        const loudness = (decibel + 52) / 26; // -52dB でほぼ無音、-26dB で全力
        const gate = Math.min(1, Math.max(0, (ratio - 0.5) / 0.2));
        micBlow.current = Math.min(1, Math.max(0, loudness)) * gate;

        metrics.current.decibel = decibel;
        metrics.current.ratio = ratio;
        metrics.current.loudness = loudness;
        metrics.current.gate = gate;

        if (audio.current) audio.current.raf = requestAnimationFrame(measure);
      };

      audio.current = { context, stream, raf: requestAnimationFrame(measure) };
      setMicState('on');
    } catch {
      setMicState('denied');
      micBlow.current = 0;
    }
  };

  // 火が消えているときのタップで再点灯する。回転操作と混ざらないよう、
  // 「ほとんど動かさずに離した」ときだけ拾う
  const pointer = useRef({ x: 0, y: 0, at: 0 });
  const onPointerDown = (event: React.PointerEvent) => {
    pointer.current = { x: event.clientX, y: event.clientY, at: performance.now() };
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const moved = Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y);
    if (moved < 6 && performance.now() - pointer.current.at < 400) io.current.relight?.();
  };

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100vh' }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <WebGPUCanvas
        title={t('ロウソクの火', 'Candle')}
        hint={t(
          <>
            炎を発光する媒質としてレイマーチし、黒体放射から色を、
            <br />
            浮力の渦輪から揺らぎを出しています。
            <br />
            ドラッグで回転、スクロールでズーム。
          </>,
          <>
            The flame is ray-marched as an emissive medium. Colour comes from black-body radiation,
            <br />
            the motion from buoyancy-driven vortices.
            <br />
            Drag to orbit, scroll to zoom.
          </>
        )}
        setup={setup}
      />

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 28,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          pointerEvents: 'none'
        }}
      >
        {/* 息の強さ。しきい値を超えると色が変わり、そのまま吹き続けると消える */}
        <div
          style={{
            width: 220,
            height: 4,
            borderRadius: 2,
            background: 'rgba(255, 255, 255, 0.14)',
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              width: `${Math.round(level * 100)}%`,
              height: '100%',
              background: level > EXTINGUISH_BLOW ? '#ff6b3d' : '#8ec5ff',
              transition: 'width 80ms linear, background 200ms'
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 18px',
            borderRadius: 999,
            background: 'rgba(0, 0, 0, 0.5)',
            backdropFilter: 'blur(6px)',
            color: '#f2f4f8',
            font: '13px/1.6 system-ui, sans-serif',
            pointerEvents: 'auto'
          }}
        >
          {lit ? (
            <span>{t('スペースキー長押し、またはマイクで息を吹きかける', 'Hold Space, or blow into your microphone')}</span>
          ) : (
            <span>{t('火が消えました。画面をタップで再点灯', 'The flame is out. Tap anywhere to relight')}</span>
          )}

          <button
            type="button"
            onClick={enableMicrophone}
            disabled={micState === 'on' || micState === 'requesting'}
            style={{
              padding: '5px 12px',
              borderRadius: 999,
              border: '1px solid rgba(255, 255, 255, 0.22)',
              background: micState === 'on' ? 'rgba(110, 231, 168, 0.18)' : 'rgba(255, 255, 255, 0.08)',
              color: micState === 'denied' ? '#ffb4ac' : '#f2f4f8',
              font: '12px system-ui, sans-serif',
              cursor: micState === 'on' ? 'default' : 'pointer'
            }}
          >
            {micState === 'on'
              ? t('🎤 マイク使用中', '🎤 Microphone on')
              : micState === 'requesting'
                ? t('許可を待っています…', 'Waiting for permission…')
                : micState === 'denied'
                  ? t('マイクを使えませんでした', 'Microphone unavailable')
                  : t('🎤 マイクで吹きかける', '🎤 Blow with your mic')}
          </button>
        </div>

        {micState === 'on' && readout && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              background: 'rgba(0, 0, 0, 0.55)',
              backdropFilter: 'blur(6px)',
              color: '#dfe6f0',
              font: '11px/1.7 "SFMono-Regular", Menlo, Consolas, monospace',
              fontVariantNumeric: 'tabular-nums',
              pointerEvents: 'none',
              minWidth: 300
            }}
          >
            <Row
              label={t('低域 80–600Hz', 'Low band 80–600Hz')}
              value={`${readout.now.decibel.toFixed(1)} dB`}
              peak={`${readout.peak.decibel.toFixed(1)} dB`}
            />
            <Row
              label={t('低域の比率', 'Low-band ratio')}
              value={readout.now.ratio.toFixed(3)}
              peak={readout.peak.ratio.toFixed(3)}
            />
            <Row
              label={t('音量 (dB+52)/26', 'Loudness (dB+52)/26')}
              value={readout.now.loudness.toFixed(3)}
              peak={readout.peak.loudness.toFixed(3)}
            />
            <Row
              label={t('ゲート (比率-0.5)/0.2', 'Gate (ratio-0.5)/0.2')}
              value={readout.now.gate.toFixed(3)}
              peak={readout.peak.gate.toFixed(3)}
            />
            <Row
              label={t('息の強さ = 音量 × ゲート', 'Breath = loudness × gate')}
              value={readout.now.blow.toFixed(3)}
              peak={readout.peak.blow.toFixed(3)}
              highlight
            />
            <div style={{ marginTop: 6, opacity: 0.5 }}>
              {t(
                '0.55 を超えると消えはじめます／右の数字は直近のピーク',
                'Above 0.55 the flame starts to go out / right column is the recent peak'
              )}
            </div>
            <div style={{ marginTop: 2, opacity: 0.5 }}>
              {t(
                '音はブラウザ内で解析しているだけで、録音も送信もしていません',
                'Audio is analysed in the browser only — nothing is recorded or sent'
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Candle;
