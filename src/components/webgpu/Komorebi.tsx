import React, { useCallback } from 'react';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BackSide,
  DoubleSide,
  FogExp2,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  type MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  RenderPipeline,
  RenderTarget,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  Sprite,
  SpriteNodeMaterial,
  type Texture,
  TextureLoader,
  Vector3
} from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  cameraPosition,
  clamp,
  color,
  deltaTime,
  dot,
  exp,
  float,
  instancedArray,
  instanceIndex,
  max,
  mix,
  mx_fractal_noise_float,
  mx_fractal_noise_vec3,
  normalWorld,
  normalize,
  pass,
  positionLocal,
  positionWorld,
  pow,
  rand,
  screenUV,
  sign,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
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
 * 木漏れ日。
 *
 * 木はフォトグラメトリの完全なモデル（Poly Haven / CC0、1本あたり107万三角形）をそのまま林に並べ、
 * 太陽の位置から見た「葉に遮られたかどうか」を自前の影マップ（RenderTarget）に毎フレーム焼いている。
 * 地面の光斑も、空中の光の柱も、漂う塵のきらめきも、すべてこの1枚のマップから読む。
 * 見上げれば、その葉が裏から陽を透かして光っているのが見える。
 */

/** TSL のノードは型が複雑なので、シェーダー組み立て用ヘルパーの引数はこの別名で受ける */
type TSLNode = any;

const ASSETS = '/assets/polyhaven';

/** 影マップを焼く対象。木を増やすとここが重くなるので、手前の木だけを入れる */
const NEAR_TREES = 8;
/** 樹冠の厚みを出すための中景。影マップには入れない（影の見え方はほぼ手前の木で決まる） */
const MIDDLE_TREES = 6;
/** 霧の中に沈む奥の木立。影マップには入れない */
const FAR_TREES = 7;
const DUST_COUNT = 80000;
const DUST_AREA = 22;
const DUST_HEIGHT = 9;
/** 影マップの解像度と、それが覆うワールドの半径 */
const LIGHT_MAP_SIZE = 2048;
const LIGHT_MAP_EXTENT = 20;
/** 葉が存在しうる高さの上限（光の柱のレイマーチを打ち切るのに使う） */
const CANOPY_TOP = 15.0;

const setup: SceneSetup = async ({ renderer, scene, camera, canvas }) => {
  // --- 外部アセット（Poly Haven / CC0。assets/polyhaven/CREDITS.md 参照） ---
  const textureLoader = new TextureLoader();
  const loadTexture = async (file: string, srgb: boolean, repeat = true) => {
    const map = await textureLoader.loadAsync(`${ASSETS}/${file}`);
    if (srgb) map.colorSpace = SRGBColorSpace;
    if (repeat) map.wrapS = map.wrapT = RepeatWrapping;
    return map;
  };
  const gltfLoader = new GLTFLoader();

  const [leafAlphaMap, groundDiffuse, treeGltf, stumpGltf, logGltf, rockGltf] = await Promise.all([
    // glTF のテクスチャは jpg なのでアルファを持てない。葉の抜きは別ファイルから与える
    loadTexture('island_tree_02_leaves_alpha_1k.jpg', false, false),
    loadTexture('forest_leaves_02_diffuse_1k.jpg', true),
    gltfLoader.loadAsync(`${ASSETS}/island_tree_02/island_tree_02_1k.gltf`),
    gltfLoader.loadAsync(`${ASSETS}/tree_stump_01/tree_stump_01_1k.gltf`),
    gltfLoader.loadAsync(`${ASSETS}/dead_tree_trunk_02/dead_tree_trunk_02_1k.gltf`),
    gltfLoader.loadAsync(`${ASSETS}/rock_moss_set_01/rock_moss_set_01_1k.gltf`)
  ]);

  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.36;
  renderer.setClearColor(0x000000, 1);

  scene.fog = new FogExp2(0x4e6349, 0.022);

  // 葉の天井を見上げられるよう、注視点は樹冠の中に置く
  camera.position.set(0.5, 1.6, 6.5);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 5.0, 0);
  controls.enableDamping = true;
  controls.minDistance = 3;
  controls.maxDistance = 10;
  controls.minPolarAngle = Math.PI * 0.08;
  controls.maxPolarAngle = Math.PI * 0.93; // カメラを注視点より下へ回り込ませて、見上げられるようにする
  controls.update();

  const sunDirection = new Vector3(0.3, 0.78, -0.55).normalize();
  const sunDir = vec3(sunDirection.x, sunDirection.y, sunDirection.z);
  const sunColor = color(0xffeec4);

  // --- 太陽から見た「葉に遮られたか」を焼くマップ（＝自前の影マップ） ---
  const lightMap = new RenderTarget(LIGHT_MAP_SIZE, LIGHT_MAP_SIZE, { depthBuffer: true });
  lightMap.texture.generateMipmaps = false;

  const sunCamera = new OrthographicCamera(
    -LIGHT_MAP_EXTENT,
    LIGHT_MAP_EXTENT,
    LIGHT_MAP_EXTENT,
    -LIGHT_MAP_EXTENT,
    0.5,
    70
  );
  sunCamera.position.copy(sunDirection).multiplyScalar(32);
  sunCamera.lookAt(0, 0, 0);
  sunCamera.updateMatrixWorld();
  sunCamera.layers.set(1); // 影を落とす木だけを描く
  const sunViewProjection = uniform(
    new Matrix4().multiplyMatrices(sunCamera.projectionMatrix, sunCamera.matrixWorldInverse)
  );

  /** ワールド座標が、太陽からどれだけ光を受け取れるか（0=葉の影, 1=素通し） */
  const lightAt = (worldPosition: TSLNode) => {
    const clip = sunViewProjection.mul(vec4(worldPosition.xyz, 1.0));
    const mapUv = clip.xy.mul(0.5).add(0.5);
    return float(1.0).sub(texture(lightMap.texture, mapUv).level(float(0)).r);
  };

  /** 少しぼかして読む。木漏れ日の光斑は輪郭がやわらかい */
  const softLightAt = (worldPosition: TSLNode, radius: number) => {
    const clip = sunViewProjection.mul(vec4(worldPosition.xyz, 1.0));
    const mapUv = clip.xy.mul(0.5).add(0.5);
    const texel = radius / LIGHT_MAP_SIZE;
    const sample = (dx: number, dy: number) =>
      texture(lightMap.texture, mapUv.add(vec2(dx * texel, dy * texel))).level(float(0)).r;
    const blocked = sample(0, 0)
      .add(sample(1.5, 0.5))
      .add(sample(-1.5, -0.5))
      .add(sample(0.5, -1.5))
      .add(sample(-0.5, 1.5))
      .mul(0.2);
    return float(1.0).sub(blocked);
  };

  // --- 空 ---
  const skyMaterial = new MeshBasicNodeMaterial({ side: BackSide, fog: false });
  {
    const direction = normalize(positionWorld);
    const up = clamp(direction.y, 0.0, 1.0);
    const base = mix(color(0xd8e6c8), color(0x8fc4ee), pow(up, 0.75));
    const toSun = max(dot(direction, sunDir), 0.0);
    // 葉の隙間から覗いたときに白く飛ぶよう、太陽まわりは思い切り明るくする
    const disc = pow(toSun, 1800.0).mul(26.0);
    const glow = pow(toSun, 14.0).mul(1.1);
    skyMaterial.colorNode = base.mul(0.85).add(sunColor.mul(disc.add(glow)));
  }
  scene.add(new Mesh(new SphereGeometry(120, 32, 20), skyMaterial));

  /**
   * 拡散面の陰影。空からの環境光（半球）と、葉の影マップを通した直射日光を足す。
   * 地面も幹も倒木も岩も、すべてこれ1本で塗る。
   */
  const litSurface = (baseColor: TSLNode, blurRadius = 2.5) => {
    const skyAmbient = normalWorld.y.mul(0.5).add(0.5).mul(0.3).add(0.05);
    const direct = softLightAt(positionWorld, blurRadius).mul(max(dot(normalWorld, sunDir), 0.0));
    return baseColor.mul(skyAmbient).add(baseColor.mul(sunColor).mul(pow(direct, 1.7).mul(2.2)));
  };

  // --- 地面（実写の林床テクスチャを敷く） ---
  const groundMaterial = new MeshBasicNodeMaterial();
  {
    // 継ぎ目が目立たないよう、スケールの違う2枚を重ねて割る
    const coarse = texture(groundDiffuse, uv().mul(30.0));
    const fine = texture(groundDiffuse, uv().mul(74.0).add(0.37));
    const blend = mx_fractal_noise_float(vec3(positionWorld.xz.mul(0.11), 0.0), 3, 2.0, 0.5, 1.0)
      .mul(0.5)
      .add(0.5);
    groundMaterial.colorNode = litSurface(
      mix(coarse, fine, smoothstep(0.35, 0.65, blend)).rgb.mul(0.6),
      3.0
    );
  }
  const ground = new Mesh(new PlaneGeometry(70, 70), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // --- 木（フォトグラメトリの完全なモデル） ---

  /** モデルから、部位ごとのカラーテクスチャを拾い出す */
  const treeMaps: { leaves?: Texture; branches?: Texture; trunk?: Texture } = {};
  treeGltf.scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as MeshStandardMaterial;
    if (!material.map) return;
    if (material.name.endsWith('_leaves')) treeMaps.leaves = material.map;
    else if (material.name.endsWith('_branches')) treeMaps.branches = material.map;
    else treeMaps.trunk = material.map;
  });

  /**
   * 風。葉のメッシュは1枚ずつ分かれていないので、モデルローカル座標のノイズで面ごとに揺らす。
   * 幹から離れているほど大きく振れる。影マップ側も同じノードを使うので、影も一緒に揺れる。
   */
  const leafWind = Fn(() => {
    const local = positionLocal;
    const flow = mx_fractal_noise_vec3(
      local.mul(0.5).add(vec3(time.mul(0.38), time.mul(0.13), time.mul(0.29))),
      2,
      2.0,
      0.5,
      1.0
    );
    const amount = smoothstep(0.3, 2.4, local.xz.length()).mul(0.075).add(0.012);
    return local.add(flow.mul(amount));
  })();

  const leafOpacity = texture(leafAlphaMap).r;

  const leafMaterial = new MeshBasicNodeMaterial({ side: DoubleSide });
  leafMaterial.alphaTest = 0.5;
  leafMaterial.opacityNode = leafOpacity;
  leafMaterial.positionNode = leafWind;
  {
    const albedo = texture(treeMaps.leaves!).rgb.mul(vec3(0.82, 1.04, 0.76));

    const viewDirection = normalize(positionWorld.sub(cameraPosition));
    // 両面描画なので、こちらを向いている側を法線として扱う
    const facing = normalWorld.mul(sign(dot(normalWorld, viewDirection.negate())));

    // 樹冠の中の葉は上の葉に隠れて暗い。自分自身を数えないよう、太陽側に少しずらして影マップを引く
    const exposed = lightAt(positionWorld.add(sunDir.mul(0.9)));

    const towardSun = max(dot(viewDirection, sunDir), 0.0);
    const backLit = max(dot(facing, sunDir).negate(), 0.0);
    const frontLit = max(dot(facing, sunDir), 0.0);

    // 葉が陽を透かす。裏から照らされ、かつ視線が太陽の方を向いているほど強く光る
    const transmission = pow(backLit, 1.3).mul(pow(towardSun, 2.2)).mul(exposed).mul(2.4);
    const glow = mix(albedo.mul(vec3(1.15, 1.4, 0.45)), sunColor, 0.22).mul(transmission);

    const sky = albedo.mul(color(0x3d4c39)).mul(0.42);
    leafMaterial.colorNode = albedo.mul(frontLit.mul(exposed).mul(1.7).add(0.07)).add(glow).add(sky);
  }

  const barkMaterial = new MeshBasicNodeMaterial();
  barkMaterial.colorNode = litSurface(texture(treeMaps.trunk!).rgb.mul(0.85), 2.0);

  const branchMaterial = new MeshBasicNodeMaterial({ side: DoubleSide });
  branchMaterial.colorNode = litSurface(texture(treeMaps.branches!).rgb.mul(0.85), 1.6);

  // 影マップを焼くときに差し替えるマテリアル。葉は同じ抜きと同じ風で、真っ白に塗りつぶす
  const leafMaskMaterial = new MeshBasicNodeMaterial({ side: DoubleSide, fog: false });
  leafMaskMaterial.alphaTest = 0.5;
  leafMaskMaterial.opacityNode = leafOpacity;
  leafMaskMaterial.positionNode = leafWind;
  leafMaskMaterial.colorNode = color(0xffffff);

  const solidMaskMaterial = new MeshBasicNodeMaterial({ side: DoubleSide, fog: false });
  solidMaskMaterial.colorNode = color(0xffffff);

  /** 影マップのパスでマテリアルを差し替える対象 */
  const shadowCasters: Array<{ mesh: Mesh; main: MeshBasicNodeMaterial; mask: MeshBasicNodeMaterial }> = [];

  /** 木を1本生やす。castsShadow のものだけが影マップに描かれる */
  const plantTree = (x: number, z: number, scale: number, rotation: number, castsShadow: boolean) => {
    const tree = treeGltf.scene.clone(true);
    tree.position.set(x, 0, z);
    tree.scale.setScalar(scale);
    tree.rotation.y = rotation;
    tree.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const name = (mesh.material as MeshStandardMaterial).name;
      const isLeaf = name.endsWith('_leaves');
      const main = isLeaf ? leafMaterial : name.endsWith('_branches') ? branchMaterial : barkMaterial;
      mesh.material = main;
      if (castsShadow) {
        mesh.layers.enable(1);
        shadowCasters.push({ mesh, main, mask: isLeaf ? leafMaskMaterial : solidMaskMaterial });
      }
    });
    scene.add(tree);
  };

  // 手前の林。カメラの可動域（半径11）を避けつつ、樹冠が頭上で重なるように配置する
  for (let i = 0; i < NEAR_TREES; i += 1) {
    const angle = (i / NEAR_TREES) * Math.PI * 2 + Math.sin(i * 4.7) * 0.32;
    const distance = 6.8 + Math.abs(Math.sin(i * 2.3)) * 4.4;
    plantTree(
      Math.cos(angle) * distance,
      Math.sin(angle) * distance,
      3.0 + Math.abs(Math.sin(i * 3.1)) * 0.9,
      i * 2.1,
      true
    );
  }

  // 中景。頭上の葉を厚くするために足す
  for (let i = 0; i < MIDDLE_TREES; i += 1) {
    const angle = (i / MIDDLE_TREES) * Math.PI * 2 + 0.4 + Math.sin(i * 3.3) * 0.4;
    const distance = 12.5 + Math.abs(Math.sin(i * 2.7)) * 5.0;
    plantTree(
      Math.cos(angle) * distance,
      Math.sin(angle) * distance,
      3.2 + Math.abs(Math.sin(i * 5.7)) * 1.0,
      i * 1.7,
      false
    );
  }

  // 奥の木立。霧に溶けて奥行きを作る
  for (let i = 0; i < FAR_TREES; i += 1) {
    const angle = (i / FAR_TREES) * Math.PI * 2 + 0.7 + Math.sin(i * 5.9) * 0.3;
    const distance = 21 + Math.abs(Math.sin(i * 1.9)) * 13;
    plantTree(
      Math.cos(angle) * distance,
      Math.sin(angle) * distance,
      3.4 + Math.abs(Math.sin(i * 4.3)) * 1.2,
      i * 1.3,
      false
    );
  }

  // --- 林床に置く小物（フォトグラメトリのモデル） ---
  {
    /** 読み込んだ glTF のマテリアルを、このシーンの陰影に差し替える */
    const adopt = (source: Object3D, blurRadius = 2.0) => {
      const clone = source.clone(true);
      clone.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const original = mesh.material as MeshStandardMaterial;
        const material = new MeshBasicNodeMaterial();
        material.colorNode = original.map
          ? litSurface(texture(original.map).rgb, blurRadius)
          : litSurface(color(0x6b6252), blurRadius);
        mesh.material = material;
      });
      return clone;
    };

    const rocks = rockGltf.scene.children.slice();

    ([
      [4.4, -5.0, 0.9, 0.7],
      [-6.2, 3.2, 0.75, 2.4]
    ] as const).forEach(([x, z, scale, rotation]) => {
      const mesh = adopt(stumpGltf.scene);
      mesh.position.set(x, -0.08, z);
      mesh.scale.setScalar(scale);
      mesh.rotation.y = rotation;
      scene.add(mesh);
    });

    ([
      [-3.4, 5.4, 0.8, 1.15],
      [6.6, 2.3, 0.65, -0.6]
    ] as const).forEach(([x, z, scale, rotation]) => {
      const mesh = adopt(logGltf.scene);
      mesh.position.set(x, 0.0, z);
      mesh.scale.setScalar(scale);
      mesh.rotation.y = rotation;
      scene.add(mesh);
    });

    for (let i = 0; i < 22; i += 1) {
      const mesh = adopt(rocks[i % rocks.length], 1.4);
      const angle = i * 2.39996;
      const radius = 2.6 + Math.sqrt((i + 0.5) / 22) * 12;
      const scale = 0.4 + Math.abs(Math.sin(i * 5.3)) * 0.9;
      mesh.position.set(Math.cos(angle) * radius, -0.08 * scale, Math.sin(angle) * radius);
      mesh.scale.setScalar(scale);
      mesh.rotation.set(0, i * 1.31, 0);
      scene.add(mesh);
    }
  }

  // --- 光の柱（影マップをレイマーチングで積分する） ---
  const shaftMaterial = new MeshBasicNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: BackSide,
    fog: false
  });
  {
    const STEPS = 26;
    const STEP_SIZE = 0.72;

    // toVar / Loop はシェーダー関数の中でしか組み立てられないので Fn で包む
    shaftMaterial.colorNode = Fn(() => {
      const rayDirection = normalize(positionWorld.sub(cameraPosition));
      // 一定間隔だと縞が出るので、画面座標でサンプル位置をずらす
      const jitter = rand(screenUV.mul(vec2(443.7, 917.3)).add(time)).mul(STEP_SIZE);
      const accumulated = float(0).toVar();

      Loop(STEPS, ({ i }: { i: TSLNode }) => {
        const distance = float(i).mul(STEP_SIZE).add(jitter).add(0.4);
        const samplePoint = cameraPosition.add(rayDirection.mul(distance));

        If(samplePoint.y.lessThan(-0.2).or(samplePoint.y.greaterThan(CANOPY_TOP)), () => {
          Break();
        });

        const light = lightAt(samplePoint);
        const aboveGround = smoothstep(-0.1, 1.0, samplePoint.y);
        const falloff = exp(distance.mul(-0.1));

        accumulated.addAssign(light.mul(aboveGround).mul(falloff));
      });

      return vec4(sunColor, clamp(accumulated.mul(0.035), 0.0, 0.55));
    })();
  }
  const shafts = new Mesh(new SphereGeometry(40, 24, 16), shaftMaterial);
  shafts.frustumCulled = false;
  shafts.renderOrder = 10;
  scene.add(shafts);

  // --- 舞う塵 ---
  const dustPosition = instancedArray(DUST_COUNT, 'vec3');
  const dustSeed = instancedArray(DUST_COUNT, 'float');

  const computeInit = Fn(() => {
    const position = dustPosition.element(instanceIndex);
    const seed = dustSeed.element(instanceIndex);
    const id = instanceIndex.toFloat();

    seed.assign(rand(vec2(id.mul(0.0021), 3.17)));
    position.assign(
      vec3(
        rand(vec2(id.mul(0.0013), 1.7)).sub(0.5).mul(DUST_AREA),
        rand(vec2(id.mul(0.0017), 5.3)).mul(DUST_HEIGHT).sub(1.0),
        rand(vec2(id.mul(0.0019), 9.1)).sub(0.5).mul(DUST_AREA)
      )
    );
  })().compute(DUST_COUNT);

  const computeUpdate = Fn(() => {
    const position = dustPosition.element(instanceIndex);
    const seed = dustSeed.element(instanceIndex);
    const dt = deltaTime.min(1 / 30);

    const flow = mx_fractal_noise_vec3(
      position.mul(0.3).add(vec3(0.0, time.mul(0.09), 0.0)).add(seed.mul(23.0)),
      2,
      2.0,
      0.5,
      1.0
    );
    const velocity = vec3(flow.x.mul(0.3), flow.y.mul(0.14).add(0.04), flow.z.mul(0.3));
    position.addAssign(velocity.mul(dt));

    position.assign(
      vec3(
        position.x.add(DUST_AREA * 1.5).mod(DUST_AREA).sub(DUST_AREA / 2),
        position.y.add(DUST_HEIGHT + 1.0).mod(DUST_HEIGHT).sub(1.0),
        position.z.add(DUST_AREA * 1.5).mod(DUST_AREA).sub(DUST_AREA / 2)
      )
    );
  })().compute(DUST_COUNT);

  renderer.computeAsync(computeInit);

  const dustMaterial = new SpriteNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false
  });
  {
    const worldPosition = dustPosition.toAttribute();
    const seed = dustSeed.toAttribute();

    const inLight = lightAt(worldPosition);
    const twinkle = sin(time.mul(2.6).add(seed.mul(210.0))).mul(0.35).add(0.65);
    const falloff = smoothstep(0.5, 0.08, uv().sub(0.5).length());
    // カメラのすぐ手前にある塵は巨大なボケ玉になってしまうので消す
    const nearFade = smoothstep(0.8, 3.0, worldPosition.distance(cameraPosition));

    dustMaterial.positionNode = worldPosition;
    dustMaterial.scaleNode = float(0.005).add(seed.mul(0.008));
    dustMaterial.colorNode = vec4(sunColor, falloff.mul(pow(inLight, 2.0)).mul(twinkle).mul(nearFade).mul(0.9));
  }
  const dust = new Sprite(dustMaterial);
  dust.count = DUST_COUNT;
  dust.frustumCulled = false;
  scene.add(dust);

  // --- ポストエフェクト（葉の隙間の陽が滲むように） ---
  const renderPipeline = new RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  renderPipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.34, 0.6, 1.1));

  return {
    update: () => {
      controls.update();
      // 見上げるほどカメラが下がるので、地面を突き抜けないところで止める
      if (camera.position.y < 0.7) camera.position.y = 0.7;
      renderer.compute(computeUpdate);

      // 太陽から見た葉のシルエットを焼き直す（風で葉が動くので毎フレーム）。
      // 葉の抜きは部位ごとに違うので、overrideMaterial ではなく1枚ずつ差し替える
      for (const caster of shadowCasters) caster.mesh.material = caster.mask;
      renderer.setRenderTarget(lightMap);
      renderer.render(scene, sunCamera);
      renderer.setRenderTarget(null);
      for (const caster of shadowCasters) caster.mesh.material = caster.main;
    },
    render: () => {
      renderPipeline.render();
    },
    dispose: () => {
      controls.dispose();
      lightMap.dispose();
    }
  };
};

const Komorebi: React.FC = () => {
  const memoizedSetup = useCallback(setup, []);
  return (
    <WebGPUCanvas
      title="木漏れ日"
      hint={
        <>
          フォトグラメトリの木を並べ、太陽から見た葉の影を毎フレーム焼いて、地面の光斑・光の柱・
          塵のきらめきをそこから読んでいます。
          <br />
          上にドラッグすると見上げられます。
        </>
      }
      setup={memoizedSetup}
    />
  );
};

export default Komorebi;
