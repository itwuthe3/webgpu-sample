import React, { useRef, useMemo } from 'react';
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

const Ocean: React.FC = () => {
  console.log('Oceanコンポーネントがレンダリングされます');

  const ref = useRef<Water>(null);
  const { scene, gl } = useThree();

  const waterNormals = useMemo(() => {
    console.log('水のテクスチャを読み込みます');
    return new THREE.TextureLoader().load('https://threejs.org/examples/textures/waternormals.jpg', (texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      console.log('水のテクスチャが正常に読み込まれました');
    });
  }, []);

  const sky = useMemo(() => {
    console.log('空を作成します');
    const sky = new Sky();
    sky.scale.setScalar(10000);
    const skyUniforms = (sky.material as THREE.ShaderMaterial).uniforms;
    skyUniforms['turbidity'].value = 10;
    skyUniforms['rayleigh'].value = 2;
    skyUniforms['mieCoefficient'].value = 0.005;
    skyUniforms['mieDirectionalG'].value = 0.8;
    return sky;
  }, []);

  const sun = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    if (ref.current) {
      ref.current.material.uniforms['time'].value += 1.0 / 60.0;
    }
  });

  React.useEffect(() => {
    console.log('Oceanコンポーネントのuseeffectが実行されます');
    scene.add(sky);
    const parameters = {
      elevation: 2,
      azimuth: 180
    };

    const pmremGenerator = new THREE.PMREMGenerator(gl);

    function updateSun() {
      const phi = THREE.MathUtils.degToRad(90 - parameters.elevation);
      const theta = THREE.MathUtils.degToRad(parameters.azimuth);
      sun.setFromSphericalCoords(1, phi, theta);
      (sky.material as THREE.ShaderMaterial).uniforms['sunPosition'].value.copy(sun);
      if (ref.current) {
        ref.current.material.uniforms['sunDirection'].value.copy(sun).normalize();
      }
      scene.environment = pmremGenerator.fromScene(new THREE.Scene().add(sky)).texture;
    }

    updateSun();
  }, [scene, sky, sun, gl]);

  return (
    <water
      ref={ref}
      args={[
        new THREE.PlaneGeometry(100000, 100000),
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
  );
};

export default Ocean;