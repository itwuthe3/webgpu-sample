import React, { useCallback } from 'react';
import {
  ACESFilmicToneMapping,
  BackSide,
  DoubleSide,
  Fog,
  Box3,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  type MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Plane,
  Raycaster,
  RenderPipeline,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  clamp,
  color,
  dot,
  exp,
  float,
  instancedArray,
  instanceIndex,
  int,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  normalize,
  pass,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  vertexIndex
} from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import WebGPUCanvas, { SceneSetup } from './WebGPUCanvas';

/**
 * 日の当たる水面のゆらぎ。
 *
 * 波を絵で描くのではなく、256×256 の格子で波動方程式を解いている。
 *   1. 高さ場をコンピュートシェーダーで2ステップ進める（ping-pong する2つのバッファ）
 *   2. その曲率から集光度（caustics）を別バッファに焼く
 *   3. 水面メッシュは頂点シェーダーで高さ場を読んで変位し、法線から空と太陽を反射する
 * 水面のきらめきも、底で踊る光の網も、すべて同じ1枚の高さ場から出てくる。
 */

/** TSL のノードは型が複雑なので、シェーダー組み立て用ヘルパーの引数はこの別名で受ける */
type TSLNode = any;

const GRID = 256;
const CELL_COUNT = GRID * GRID;
/** 水面の一辺（ワールド単位） */
const POND_SIZE = 34;
/** 水深 */
const DEPTH = 2.2;
const CELL_SIZE = POND_SIZE / (GRID - 1);

const ASSETS = '/assets/polyhaven';

const setup: SceneSetup = async ({ renderer, scene, camera, canvas }) => {
  // --- 外部アセット（Poly Haven / CC0。assets/polyhaven/CREDITS.md 参照） ---
  const gltfLoader = new GLTFLoader();
  const rockSets = await Promise.all([
    gltfLoader.loadAsync(`${ASSETS}/rock_moss_set_01/rock_moss_set_01_1k.gltf`),
    gltfLoader.loadAsync(`${ASSETS}/rock_moss_set_02/rock_moss_set_02_1k.gltf`)
  ]);

  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;

  // 池の縁が直線で切れて見えないよう、遠景は空の色に溶かす
  scene.fog = new Fog(0xc3d9ee, 14, 40);

  camera.position.set(0, 7.2, 12.5);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, -0.8, -3.0);
  controls.enableDamping = true;
  controls.minDistance = 3;
  controls.maxDistance = 26;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();

  const sunDirection = new Vector3(0.32, 0.42, -0.85).normalize();
  const sunDir = vec3(sunDirection.x, sunDirection.y, sunDirection.z);
  const sunColor = color(0xfff1d0);

  // --- 高さ場（vec2 に「現在の高さ」と「ひとつ前の高さ」を持たせる） ---
  const heightA = instancedArray(CELL_COUNT, 'vec2');
  const heightB = instancedArray(CELL_COUNT, 'vec2');
  const causticsBuffer = instancedArray(CELL_COUNT, 'float');

  const dropCenter = uniform(new Vector2(0, 0)); // 格子座標
  const dropStrength = uniform(0);

  const gridSize = int(GRID);
  const lastIndex = int(GRID - 1);

  // 整数ノードの min/max は @types/three に型が無いため、ここだけ型を緩めて包んでおく
  const clampIndex = (value: TSLNode): TSLNode => (max as TSLNode)((min as TSLNode)(value, lastIndex), int(0));

  const computeInit = Fn(() => {
    heightA.element(instanceIndex).assign(vec2(0, 0));
    heightB.element(instanceIndex).assign(vec2(0, 0));
    causticsBuffer.element(instanceIndex).assign(0);
  })().compute(CELL_COUNT);

  /** src から読んで dst に書く、波動方程式の1ステップ */
  const makeWaveStep = (src: typeof heightA, dst: typeof heightA) =>
    Fn(() => {
      const index = int(instanceIndex);
      const x = index.mod(gridSize);
      const y = index.div(gridSize);

      const heightAt = (xx: TSLNode, yy: TSLNode) => src.element(yy.mul(gridSize).add(xx)).x;

      const left = heightAt(clampIndex(x.sub(1)), y);
      const right = heightAt(clampIndex(x.add(1)), y);
      const down = heightAt(x, clampIndex(y.sub(1)));
      const up = heightAt(x, clampIndex(y.add(1)));

      const self = src.element(index);
      const current = self.x;
      const previous = self.y;

      // 波動方程式: next = 2*現在 - ひとつ前 + c^2 * ラプラシアン
      const laplacian = left.add(right).add(down).add(up).sub(current.mul(4.0));
      const next = current.mul(2.0).sub(previous).add(laplacian.mul(0.22)).mul(0.9968).toVar();

      // 雨粒／マウスによる打点
      const cell = vec2(float(x), float(y));
      const distance = cell.distance(dropCenter);
      next.addAssign(dropStrength.mul(exp(distance.mul(distance).mul(-0.05))));

      // 風による細かいさざ波を常に与え続ける（無いと水面が鏡のように止まってしまう）
      next.addAssign(mx_noise_float(vec3(cell.mul(0.11), time.mul(1.5))).mul(0.0026));

      // 縁で跳ね返ると池が箱に見えるので、外周は減衰させて波を吸わせる
      const edge = min(min(float(x), float(lastIndex.sub(x))), min(float(y), float(lastIndex.sub(y))));
      next.mulAssign(smoothstep(0.0, 10.0, edge).mul(0.05).add(0.95));

      dst.element(index).assign(vec2(next, current));
    })().compute(CELL_COUNT);

  // 1フレームに2ステップ進めて、必ず A が最新になるようにする（描画側は A だけを見ればよい）
  const waveStepAtoB = makeWaveStep(heightA, heightB);
  const waveStepBtoA = makeWaveStep(heightB, heightA);

  /** 水面の曲率から、底に届く光の集まり具合を焼く */
  const computeCaustics = Fn(() => {
    const index = int(instanceIndex);
    const x = index.mod(gridSize);
    const y = index.div(gridSize);

    const heightAt = (xx: TSLNode, yy: TSLNode) => heightA.element(yy.mul(gridSize).add(xx)).x;

    const center = heightAt(x, y);
    const laplacian = heightAt(clampIndex(x.sub(1)), y)
      .add(heightAt(clampIndex(x.add(1)), y))
      .add(heightAt(x, clampIndex(y.sub(1))))
      .add(heightAt(x, clampIndex(y.add(1))))
      .sub(center.mul(4.0));

    // 水面が凸のところではレンズのように光が集まる
    const focus = max(float(1.0).sub(laplacian.mul(70.0)), 0.0);
    causticsBuffer.element(index).assign(min(pow(focus, 3.2), 18.0));
  })().compute(CELL_COUNT);

  renderer.computeAsync(computeInit);

  // --- 空（水面の反射でも同じ関数を使う） ---
  const skyColor = (direction: TSLNode) => {
    const up = clamp(direction.y, 0.0, 1.0);
    const base = mix(color(0xbcd7ef), color(0x2f6ec8), pow(up, 0.6));
    const toSun = max(dot(direction, sunDir), 0.0);
    const disc = pow(toSun, 420.0).mul(20.0);
    const glow = pow(toSun, 8.0).mul(0.5);
    return base.add(sunColor.mul(disc.add(glow)));
  };

  const skyMaterial = new MeshBasicNodeMaterial({ side: BackSide, fog: false });
  skyMaterial.colorNode = vec4(skyColor(normalize(positionWorld)), 1.0);
  scene.add(new Mesh(new SphereGeometry(240, 32, 20), skyMaterial));

  // --- 水中の光（水面の曲率から焼いた caustics を、水底にも岩にも当てる） ---

  /** グリッド座標での双一次補間。ピクセルごとにラプラシアンを計算し直すより遙かに安い */
  const sampleCaustics = (gridPosition: TSLNode) => {
    const p = gridPosition.clamp(vec2(0.0, 0.0), vec2(GRID - 1.001, GRID - 1.001));
    const base = p.floor();
    const frac = p.sub(base);
    const x0 = int(base.x);
    const y0 = int(base.y);
    const x1 = clampIndex(x0.add(1));
    const y1 = clampIndex(y0.add(1));

    const at = (xx: TSLNode, yy: TSLNode) => causticsBuffer.element(yy.mul(gridSize).add(xx));

    return mix(mix(at(x0, y0), at(x1, y0), frac.x), mix(at(x0, y1), at(x1, y1), frac.x), frac.y);
  };

  /**
   * その一点に届く光は、水深のぶん太陽側にずれた水面を通ってきている。
   * 深さから逆算するので、水底でも岩の上でも同じ式で引ける。
   */
  const causticsAt = (worldPosition: TSLNode) => {
    const depth = worldPosition.y.negate().max(0.0);
    const entry = worldPosition.xz.add(vec2(sunDir.x, sunDir.z).mul(depth.div(sunDir.y)));
    return sampleCaustics(entry.add(POND_SIZE / 2).div(POND_SIZE).mul(GRID - 1));
  };

  /** 水中の物体の陰影。環境光＋太陽の向き＋水面から降ってくる光の網 */
  const underwater = (baseColor: TSLNode) => {
    const facing = max(dot(normalWorld, sunDir), 0.0);
    const light = causticsAt(positionWorld).mul(facing.mul(0.65).add(0.35));
    return baseColor.mul(float(0.34).add(facing.mul(0.46))).add(
      mix(color(0xbfe9d8), sunColor, 0.4).mul(light.mul(0.34))
    );
  };

  const floorMaterial = new MeshBasicNodeMaterial();
  {
    const sand = mx_fractal_noise_float(vec3(positionWorld.xz.mul(1.1), 0.0), 4, 2.0, 0.5, 1.0)
      .mul(0.5)
      .add(0.5);
    const ripples = mx_fractal_noise_float(vec3(positionWorld.xz.mul(vec2(5.5, 1.6)), 3.7), 3, 2.0, 0.5, 1.0)
      .mul(0.5)
      .add(0.5);
    // 砂紋。水底には波の跡が畝になって残る
    const bed = mix(color(0x0c2024), color(0x27443f), sand).mul(mix(float(0.82), float(1.15), ripples));
    floorMaterial.colorNode = underwater(bed);
  }
  const floorGeometry = new PlaneGeometry(POND_SIZE, POND_SIZE, 1, 1);
  floorGeometry.rotateX(-Math.PI / 2);
  const floor = new Mesh(floorGeometry, floorMaterial);
  floor.position.y = -DEPTH;
  scene.add(floor);

  // --- 水中の岩と小石（フォトグラメトリのモデル） ---
  {
    /**
     * 読み込んだ岩を、水中の陰影で塗り直す。
     * セットの glTF は岩が並べて置かれているので、1個ずつ原点へ寄せ直してから使う
     * （そうしないと、指定した座標からセット内の並び順ぶんずれて浮いてしまう）。
     */
    const adopt = (source: Object3D) => {
      const clone = source.clone(true);
      clone.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const original = mesh.material as MeshStandardMaterial;
        const material = new MeshBasicNodeMaterial();
        const albedo = original.map ? texture(original.map).rgb : color(0x33403a);
        // 底に接している側を落として、浮いて見えないようにする
        const contact = smoothstep(-DEPTH, -DEPTH + 0.35, positionWorld.y);
        material.colorNode = underwater(albedo.mul(0.5)).mul(mix(float(0.4), float(1.0), contact));
        mesh.material = material;
      });

      clone.updateMatrixWorld(true);
      const box = new Box3().setFromObject(clone);
      const center = box.getCenter(new Vector3());
      clone.position.set(-center.x, -box.min.y, -center.z);

      const group = new Group();
      group.add(clone);
      return group;
    };

    const rocks = rockSets.flatMap((gltf) => gltf.scene.children.slice());

    for (let i = 0; i < 18; i += 1) {
      const rock = adopt(rocks[i % rocks.length]);
      const angle = i * 2.39996;
      const radius = 1.8 + Math.sqrt((i + 0.5) / 18) * 10;
      const scale = 0.28 + Math.abs(Math.sin(i * 5.3)) * 0.6;
      // わずかに沈めて、砂に埋まっているように見せる
      rock.position.set(Math.cos(angle) * radius, -DEPTH - scale * 0.12, Math.sin(angle) * radius);
      rock.scale.setScalar(scale);
      rock.rotation.set(0, i * 1.31, 0);
      scene.add(rock);
    }

    for (let i = 0; i < 60; i += 1) {
      const pebble = adopt(rocks[(i * 5 + 2) % rocks.length]);
      const angle = i * 1.87;
      const radius = 0.9 + Math.sqrt((i + 0.5) / 60) * 13;
      const scale = 0.06 + Math.abs(Math.sin(i * 4.1)) * 0.13;
      pebble.position.set(Math.cos(angle) * radius, -DEPTH - scale * 0.2, Math.sin(angle) * radius);
      pebble.scale.set(scale, scale * 0.7, scale);
      pebble.rotation.set(0, i * 0.91, 0);
      scene.add(pebble);
    }
  }

  // --- 水面 ---
  const surfaceGeometry = new PlaneGeometry(POND_SIZE, POND_SIZE, GRID - 1, GRID - 1);
  surfaceGeometry.rotateX(-Math.PI / 2); // 頂点をXZ平面に寝かせておくと、変位も法線もそのままワールド座標になる

  const surfaceMaterial = new MeshBasicNodeMaterial({
    transparent: true,
    side: DoubleSide
  });

  // 頂点シェーダーで高さ場を読み、Y方向に持ち上げる
  surfaceMaterial.positionNode = Fn(() => {
    const height = heightA.element(vertexIndex).x;
    return positionLocal.add(vec3(0.0, height, 0.0));
  })();

  // 法線も頂点段階で隣のセルから求め、varying でフラグメントへ渡す
  const surfaceNormal = varying(
    Fn(() => {
      const index = int(vertexIndex);
      const x = index.mod(gridSize);
      const y = index.div(gridSize);
      const heightAt = (xx: TSLNode, yy: TSLNode) => heightA.element(yy.mul(gridSize).add(xx)).x;

      const dx = heightAt(clampIndex(x.add(1)), y).sub(heightAt(clampIndex(x.sub(1)), y));
      const dz = heightAt(x, clampIndex(y.add(1))).sub(heightAt(x, clampIndex(y.sub(1))));

      return normalize(vec3(dx.div(CELL_SIZE * -2.0), 1.0, dz.div(CELL_SIZE * -2.0)));
    })()
  );

  {
    const viewDirection = normalize(positionWorld.sub(cameraPosition));
    const facing = max(dot(surfaceNormal, viewDirection.negate()), 0.0);
    // 浅い角度ほど強く空を映す
    const fresnel = pow(float(1.0).sub(facing), 5.0).mul(0.92).add(0.06);
    const reflection = skyColor(reflect(viewDirection, surfaceNormal));
    const water = mix(color(0x0b3542), color(0x14606b), facing);

    surfaceMaterial.colorNode = vec4(mix(water, reflection, fresnel), mix(0.45, 0.97, fresnel));
  }

  const surface = new Mesh(surfaceGeometry, surfaceMaterial);
  scene.add(surface);

  // --- 入力（マウスで波紋、ときどき雨粒） ---
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const waterPlane = new Plane(new Vector3(0, 1, 0), 0);
  const hitPoint = new Vector3();
  let pointerIsOverWater = false;

  const onPointerMove = (event: PointerEvent) => {
    // ドラッグ中は視点操作なので、波紋は立てない
    if (event.buttons !== 0) {
      pointerIsOverWater = false;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    pointerIsOverWater = true;
  };
  const onPointerLeave = () => {
    pointerIsOverWater = false;
  };
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);

  /** ワールド座標を格子座標へ。池の外なら null */
  const toGrid = (worldX: number, worldZ: number) => {
    const gx = ((worldX + POND_SIZE / 2) / POND_SIZE) * (GRID - 1);
    const gy = ((worldZ + POND_SIZE / 2) / POND_SIZE) * (GRID - 1);
    if (gx < 0 || gy < 0 || gx > GRID - 1 || gy > GRID - 1) return null;
    return { gx, gy };
  };

  let nextRainAt = 0;

  // --- ポストエフェクト（陽のきらめきが滲むように） ---
  const renderPipeline = new RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  renderPipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.5, 0.7, 1.1));

  return {
    update: (elapsed) => {
      controls.update();

      // 打点をひとつ決める。マウスが水面上にあればそちらを優先
      let strength = 0;
      if (pointerIsOverWater) {
        raycaster.setFromCamera(pointer, camera);
        if (raycaster.ray.intersectPlane(waterPlane, hitPoint)) {
          const cell = toGrid(hitPoint.x, hitPoint.z);
          if (cell) {
            dropCenter.value.set(cell.gx, cell.gy);
            strength = 0.05;
          }
        }
      }
      if (strength === 0 && elapsed >= nextRainAt) {
        nextRainAt = elapsed + 0.25 + Math.random() * 0.55;
        dropCenter.value.set(Math.random() * (GRID - 1), Math.random() * (GRID - 1));
        strength = 0.035;
      }
      dropStrength.value = strength;

      renderer.compute(waveStepAtoB);
      renderer.compute(waveStepBtoA);
      renderer.compute(computeCaustics);
    },
    render: () => {
      renderPipeline.render();
    },
    dispose: () => {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      controls.dispose();
    }
  };
};

const WaterCaustics: React.FC = () => {
  const memoizedSetup = useCallback(setup, []);
  return (
    <WebGPUCanvas
      title="日の当たる水面"
      hint={
        <>
          256×256 の格子で波動方程式を解き、その曲率から水底の光の網を焼いています。
          <br />
          マウスを水面に重ねると波紋が立ちます。ドラッグで回転。
        </>
      }
      setup={memoizedSetup}
    />
  );
};

export default WaterCaustics;
