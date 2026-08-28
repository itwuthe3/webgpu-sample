import React from 'react';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import { LanguageProvider } from './i18n';
import Launcher from './components/Launcher';
import Candle from './components/webgpu/Candle';
import Flame from './components/webgpu/Flame';
import Komorebi from './components/webgpu/Komorebi';
import TextParticles from './components/webgpu/TextParticles';
import WaterCaustics from './components/webgpu/WaterCaustics';

console.log('Appコンポーネントがレンダリングされます');

const App: React.FC = () => {
  return (
    <LanguageProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Launcher />} />
          <Route path="/flame" element={<Flame />} />
          <Route path="/candle" element={<Candle />} />
          <Route path="/komorebi" element={<Komorebi />} />
          <Route path="/water-caustics" element={<WaterCaustics />} />
          <Route path="/text-input-3d" element={<TextParticles />} />
        </Routes>
      </Router>
    </LanguageProvider>
  );
};

export default App;
