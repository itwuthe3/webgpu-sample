import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';

console.log('Reactアプリケーションの初期化を開始します');

try {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('root要素が見つかりません');
  }

  ReactDOM.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
    rootElement
  );

  console.log('Reactアプリケーションが正常にレンダリングされました');
} catch (error) {
  console.error('Reactアプリケーションの初期化中にエラーが発生しました:', error);
}