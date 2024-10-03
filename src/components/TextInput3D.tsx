import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Text, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { useSpring, animated } from '@react-spring/three';

const Particles: React.FC<{ position: [number, number, number], exploded: boolean }> = ({ position, exploded }) => {
  const { viewport } = useThree();
  const particlesRef = useRef<THREE.Points>(null);

  const particleCount = 5000; // パーティクルの数を2000から5000に増やしました

  const [positions, colors, sizes, lifetimes] = useMemo(() => {
    const pos = new Float32Array(particleCount * 3);
    const col = new Float32Array(particleCount * 3);
    const siz = new Float32Array(particleCount);
    const life = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 0.3; // 初期分布範囲を少し広げました
      pos[i * 3 + 1] = (Math.random() - 0.5) * 0.3;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
      col[i * 3] = Math.random() * 0.5 + 0.5; // 赤
      col[i * 3 + 1] = Math.random() * 0.3; // 緑
      col[i * 3 + 2] = 0; // 青
      siz[i] = Math.random() * 0.08 + 0.02; // サイズ範囲を調整しました
      life[i] = Math.random();
    }
    return [pos, col, siz, life];
  }, []);

  useFrame((state, delta) => {
    if (exploded && particlesRef.current) {
      const particles = particlesRef.current;
      const positionArray = particles.geometry.attributes.position.array as Float32Array;
      const colorArray = particles.geometry.attributes.color.array as Float32Array;
      const sizeArray = particles.geometry.attributes.size.array as Float32Array;
      const lifetimeArray = particles.geometry.attributes.lifetime.array as Float32Array;

      for (let i = 0; i < particleCount; i++) {
        const i3 = i * 3;

        // 上昇する動き
        positionArray[i3] += (Math.random() - 0.5) * 0.015;
        positionArray[i3 + 1] += Math.random() * 0.025;
        positionArray[i3 + 2] += (Math.random() - 0.5) * 0.015;

        // ライフタイムの更新
        lifetimeArray[i] -= delta * 0.6; // ライフタイムの減少速度を調整
        if (lifetimeArray[i] <= 0) {
          // パーティクルのリセット
          positionArray[i3] = position[0] + (Math.random() - 0.5) * 0.3;
          positionArray[i3 + 1] = position[1] + (Math.random() - 0.5) * 0.3;
          positionArray[i3 + 2] = position[2] + (Math.random() - 0.5) * 0.3;
          lifetimeArray[i] = Math.random();
          sizeArray[i] = Math.random() * 0.08 + 0.02;
        }

        // 色の更新（ライフタイムに応じて黄色から赤へ）
        const life = lifetimeArray[i];
        colorArray[i3] = Math.min(1, 0.5 + life * 0.5); // 赤
        colorArray[i3 + 1] = Math.max(0, life * 0.3); // 緑
        colorArray[i3 + 2] = 0; // 青

        // サイズの更新
        sizeArray[i] *= 0.995; // サイズの減少速度を調整
      }

      particles.geometry.attributes.position.needsUpdate = true;
      particles.geometry.attributes.color.needsUpdate = true;
      particles.geometry.attributes.size.needsUpdate = true;
      particles.geometry.attributes.lifetime.needsUpdate = true;
    }
  });

  if (!exploded) return null;

  return (
    <points ref={particlesRef} position={position}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={particleCount}
          array={positions}
          itemSize={3}
        />
        <bufferAttribute
          attach="attributes-color"
          count={particleCount}
          array={colors}
          itemSize={3}
        />
        <bufferAttribute
          attach="attributes-size"
          count={particleCount}
          array={sizes}
          itemSize={1}
        />
        <bufferAttribute
          attach="attributes-lifetime"
          count={particleCount}
          array={lifetimes}
          itemSize={1}
        />
      </bufferGeometry>
      <pointsMaterial size={0.04} vertexColors sizeAttenuation transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

const Letter: React.FC<{ char: string, position: [number, number, number], exploded: boolean }> = ({ char, position, exploded }) => {
  const { viewport } = useThree();
  const meshRef = useRef<THREE.Mesh>(null);
  
  const { scale, opacity } = useSpring({
    scale: exploded ? 0 : 1,
    opacity: exploded ? 0 : 1,
    config: { mass: 1, tension: 500, friction: 15 }
  });

  return (
    <>
      <animated.mesh ref={meshRef} position={position} scale={scale.to(s => [s, s, s])}>
        <Text
          fontSize={0.5}
          color="blue"
          anchorX="center"
          anchorY="middle"
          depthOffset={0.2}
          outlineWidth={0.02}
          outlineColor="#000000"
        >
          {char}
        </Text>
      </animated.mesh>
      <Particles position={position} exploded={exploded} />
    </>
  );
};

const TextInput3D: React.FC = () => {
  const [text, setText] = useState('');
  const [exploded, setExploded] = useState(false);
  const [showPrompt, setShowPrompt] = useState(true);

  const handleKeyDown = (event: KeyboardEvent) => {
    setShowPrompt(false);
    if (event.key === 'Enter') {
      setExploded(true);
      setTimeout(() => {
        setText('');
        setExploded(false);
      }, 2000);
    } else if (event.key.length === 1) {
      setText(prev => prev + event.key);
    }
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div style={{ width: '100%', height: '100vh', position: 'relative' }}>
      <Canvas camera={{ position: [0, 0, 5], fov: 75 }}>
        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} />
        <OrbitControls />
        {text.split('').map((char, index) => (
          <Letter
            key={index}
            char={char}
            position={[(index - text.length / 2) * 0.6, 0, 0]}
            exploded={exploded}
          />
        ))}
      </Canvas>
      {showPrompt && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.7)',
          color: 'white',
          padding: '20px',
          borderRadius: '10px',
          textAlign: 'center'
        }}>
          キーボードで文字を入力してください。<br />
          Enterキーを押すと爆発します！
        </div>
      )}
    </div>
  );
};

export default TextInput3D;