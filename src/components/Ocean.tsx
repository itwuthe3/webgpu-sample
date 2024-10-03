import React, { useRef, useMemo, useEffect, useState } from 'react';
import { extend, useFrame, useThree } from '@react-three/fiber';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import * as THREE from 'three';

console.log('Oceanコンポーネントが読み込まれました');

extend({ Water, Sky });

declare global {
  namespace JSX {
    interface IntrinsicElements {
      water: any;
      sky: any;
    }
  }
}

const Ship: React.FC = () => {
  const shipRef = useRef<THREE.Group>(null);
  const [position, setPosition] = useState({ x: 0, z: 0 });
  const [rotation, setRotation] = useState(0);
  const speed = 0.1;
  const rotationSpeed = 0.05;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowUp':
          setPosition(prev => ({
            x: prev.x + Math.sin(rotation) * speed,
            z: prev.z - Math.cos(rotation) * speed
          }));
          break;
        case 'ArrowDown':
          setPosition(prev => ({
            x: prev.x - Math.sin(rotation) * speed,
            z: prev.z + Math.cos(rotation) * speed
          }));
          break;
        case 'ArrowLeft':
          setRotation(prev => prev + rotationSpeed);
          break;
        case 'ArrowRight':
          setRotation(prev => prev - rotationSpeed);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [rotation]);

  useFrame((state) => {
    if (shipRef.current) {
      shipRef.current.position.x = position.x;
      shipRef.current.position.z = position.z;
      shipRef.current.rotation.y = rotation;
      
      // 船を上下に揺らす
      shipRef.current.position.y = Math.sin(state.clock.elapsedTime * 2) * 0.1 - 0.5;
      // 船を少し傾ける
      shipRef.current.rotation.z = Math.sin(state.clock.elapsedTime) * 0.05;
      shipRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.5) * 0.03;
    }
  });

  return (
    <group ref={shipRef} position={[position.x, -0.5, position.z]}>
      {/* 船体 */}
      <mesh>
        <boxGeometry args={[4, 1, 8]} />
        <meshStandardMaterial color="#8B4513" />
      </mesh>
      {/* デッキ */}
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[3.8, 0.2, 7.8]} />
        <meshStandardMaterial color="#D2691E" />
      </mesh>
      {/* キャビン */}
      <mesh position={[0, 0.9, -2]}>
        <boxGeometry args={[2, 1, 3]} />
        <meshStandardMaterial color="#A0522D" />
      </mesh>
      {/* マスト */}
      <mesh position={[0, 3, 1]}>
        <cylinderGeometry args={[0.1, 0.1, 5, 8]} />
        <meshStandardMaterial color="#8B4513" />
      </mesh>
      {/* 帆 */}
      <mesh position={[0, 2, 1]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[3, 4]} />
        <meshStandardMaterial color="#F0F0F0" side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
};

const Ocean: React.FC = () => {
  console.log('Oceanコンポーネントがレンダリングされます');

  const ref = useRef<Water>(null);
  const skyRef = useRef<Sky>(null);
  const shipRef = useRef<THREE.Group>(null);
  const { scene, gl } = useThree();

  const waterNormals = useMemo(() => {
    console.log('水のテクスチャを読み込みます');
    return new THREE.TextureLoader().load('https://threejs.org/examples/textures/waternormals.jpg', (texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      console.log('水のテクスチャが正常に読み込まれました');
    });
  }, []);

  const sun = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    if (ref.current) {
      ref.current.material.uniforms['time'].value += 1.0 / 60.0;
    }
    if (shipRef.current) {
      // 船を上下に揺らす
      shipRef.current.position.y = Math.sin(state.clock.elapsedTime * 2) * 0.1 - 0.5;
      // 船を少し傾ける
      shipRef.current.rotation.z = Math.sin(state.clock.elapsedTime) * 0.05;
      shipRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.5) * 0.03;
    }
  });

  useEffect(() => {
    console.log('Oceanコンポーネントのuseeffectが実行されます');
    const sky = skyRef.current;
    if (sky) {
      sky.scale.setScalar(450000);
      const uniforms = sky.material.uniforms;
      uniforms['turbidity'].value = 10;
      uniforms['rayleigh'].value = 2;
      uniforms['mieCoefficient'].value = 0.005;
      uniforms['mieDirectionalG'].value = 0.8;
    }

    const parameters = {
      elevation: 2,
      azimuth: 180
    };

    const pmremGenerator = new THREE.PMREMGenerator(gl);

    function updateSun() {
      const phi = THREE.MathUtils.degToRad(90 - parameters.elevation);
      const theta = THREE.MathUtils.degToRad(parameters.azimuth);
      sun.setFromSphericalCoords(1, phi, theta);
      if (sky) {
        sky.material.uniforms['sunPosition'].value.copy(sun);
      }
      if (ref.current) {
        ref.current.material.uniforms['sunDirection'].value.copy(sun).normalize();
      }
      scene.environment = pmremGenerator.fromScene(sky as any).texture;
    }

    updateSun();
  }, [scene, sun, gl]);

  return (
    <>
      <sky ref={skyRef} scale={450000} />
      <water
        ref={ref}
        args={[
          new THREE.PlaneGeometry(10000, 10000),
          {
            textureWidth: 512,
            textureHeight: 512,
            waterNormals,
            sunDirection: new THREE.Vector3(),
            sunColor: 0xffffff,
            waterColor: 0x001e0f,
            distortionScale: 3.7,
            fog: scene.fog !== undefined
          }
        ]}
        rotation-x={-Math.PI / 2}
        position={[0, -1, 0]}
      />
      <Ship />
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 5]} intensity={1} />
    </>
  );
};

export default Ocean;