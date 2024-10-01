import React from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import Ocean from './Ocean';

console.log('Appコンポーネントがレンダリングされます');

const App: React.FC = () => {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Canvas
        camera={{ position: [0, 10, 100], fov: 75 }}
        style={{ width: '100%', height: '100%' }}
      >
        <OrbitControls />
        <Ocean />
      </Canvas>
    </div>
  );
};

export default App;