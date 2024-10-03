import React from 'react';
import { BrowserRouter as Router, Route, Link, Routes } from 'react-router-dom';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import Ocean from './components/Ocean';
import TextInput3D from './components/TextInput3D';

console.log('Appコンポーネントがレンダリングされます');

const OceanScene: React.FC = () => (
  <Canvas
    camera={{ position: [0, 10, 100], fov: 75 }}
    style={{ width: '100%', height: '100%' }}
  >
    <OrbitControls />
    <Ocean />
  </Canvas>
);

const App: React.FC = () => {
  return (
    <Router>
      <div style={{ width: '100%', height: '100%' }}>
        <Routes>
          <Route path="/" element={
            <div>
              <h1>WebGPUサンプル一覧</h1>
              <nav>
                <ul>
                  <li><Link to="/ocean">海のサンプル</Link></li>
                  <li><Link to="/text-input-3d">3Dテキスト入力サンプル</Link></li>
                </ul>
              </nav>
            </div>
          } />
          <Route path="/ocean" element={<OceanScene />} />
          <Route path="/text-input-3d" element={<TextInput3D />} />
        </Routes>
      </div>
    </Router>
  );
};

export default App;