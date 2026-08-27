import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';

/**
 * WebGPU サンプル共通の土台。
 *
 * WebGPURenderer の初期化は非同期（`await renderer.init()`）なので、
 * 各サンプルはシーン構築を `setup` に切り出して、初期化完了後に呼んでもらう。
 */
export type SceneContext = {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
};

export type SceneController = {
  /** 毎フレーム呼ばれる。TSL の time / deltaTime は自動更新されるので、ここはCPU側の処理だけ */
  update?: (elapsed: number, delta: number) => void;
  /** 既定の renderer.render(scene, camera) を差し替えたいとき（ポストエフェクトを挟む場合など） */
  render?: () => void;
  dispose?: () => void;
};

export type SceneSetup = (ctx: SceneContext) => SceneController | Promise<SceneController>;

type Props = {
  title: string;
  /** 画面左上に出す操作説明 */
  hint: React.ReactNode;
  setup: SceneSetup;
};

const hasWebGPU = () => typeof navigator !== 'undefined' && 'gpu' in navigator;

const WebGPUCanvas: React.FC<Props> = ({ title, hint, setup }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const setupRef = useRef(setup);
  setupRef.current = setup;

  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!hasWebGPU()) {
      setError('このブラウザは WebGPU に対応していません。Chrome / Edge / Safari の最新版でお試しください。');
      return;
    }

    let disposed = false;
    let renderer: WebGPURenderer | null = null;
    let controller: SceneController | null = null;
    let onResize: (() => void) | null = null;

    (async () => {
      const r = new WebGPURenderer({ canvas, antialias: true });
      renderer = r;

      try {
        await r.init();
      } catch (e) {
        setError(`WebGPU の初期化に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (disposed) return;

      const scene = new Scene();
      const camera = new PerspectiveCamera(50, 1, 0.1, 500);

      const resize = () => {
        const w = canvas.clientWidth || window.innerWidth;
        const h = canvas.clientHeight || window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        r.setSize(w, h, false);
      };
      r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      resize();

      try {
        controller = (await setupRef.current({ renderer: r, scene, camera, canvas })) ?? {};
      } catch (e) {
        setError(`シーンの構築に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (disposed) {
        controller.dispose?.();
        return;
      }

      onResize = resize;
      window.addEventListener('resize', resize);

      const start = performance.now();
      let last = start;
      let frames = 0;
      let fpsCheckedAt = start;

      r.setAnimationLoop(() => {
        const now = performance.now();
        // タブ復帰時に delta が跳ねてシミュレーションが破綻しないよう頭を抑える
        const delta = Math.min((now - last) / 1000, 1 / 20);
        last = now;

        controller?.update?.((now - start) / 1000, delta);
        if (controller?.render) {
          controller.render();
        } else {
          r.render(scene, camera);
        }

        frames += 1;
        if (now - fpsCheckedAt >= 500) {
          setFps(Math.round((frames * 1000) / (now - fpsCheckedAt)));
          frames = 0;
          fpsCheckedAt = now;
        }
      });
    })();

    return () => {
      disposed = true;
      if (onResize) window.removeEventListener('resize', onResize);
      renderer?.setAnimationLoop(null);
      controller?.dispose?.();
      renderer?.dispose();
    };
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh', background: '#05070a' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          maxWidth: 320,
          padding: '12px 16px',
          borderRadius: 10,
          background: 'rgba(0, 0, 0, 0.45)',
          backdropFilter: 'blur(6px)',
          color: '#f2f4f8',
          font: '13px/1.7 system-ui, sans-serif',
          pointerEvents: 'none'
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{title}</div>
        <div style={{ opacity: 0.85 }}>{hint}</div>
        <div style={{ marginTop: 8, opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>{fps} fps</div>
      </div>

      <Link
        to="/"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          padding: '8px 14px',
          borderRadius: 8,
          background: 'rgba(0, 0, 0, 0.45)',
          color: '#f2f4f8',
          font: '13px system-ui, sans-serif',
          textDecoration: 'none'
        }}
      >
        ← 一覧へ
      </Link>

      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            textAlign: 'center',
            color: '#f2f4f8',
            font: '15px/1.9 system-ui, sans-serif'
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
};

export default WebGPUCanvas;
