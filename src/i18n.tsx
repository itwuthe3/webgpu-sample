import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Language = 'ja' | 'en';

const STORAGE_KEY = 'webgpu-sample:language';

/**
 * 表示言語を決める。
 *
 * 「日本からのアクセスは日本語」を IP で判定するとサーバー側の仕組みが要る
 * （Cloudflare Pages Functions なら `request.cf.country` で取れる）。ここでは
 * サーバーを持たずに済ませたいので、**ブラウザの言語設定とタイムゾーン**で判定する。
 *
 * どちらか一方でも日本を指していれば日本語にする。言語設定だけを見ると
 * 日本在住で英語ブラウザの人に英語が出てしまい、タイムゾーンだけを見ると
 * 旅行中の日本人に英語が出てしまうため。手動で切り替えた場合はそれを最優先する。
 */
const detectLanguage = (): Language => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ja' || saved === 'en') return saved;
  } catch {
    // プライベートウィンドウなどで読めないことがある。判定に進む
  }

  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  if (tags.some((tag) => tag?.toLowerCase().startsWith('ja'))) return 'ja';

  try {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'Asia/Tokyo') return 'ja';
  } catch {
    // タイムゾーンが取れない環境。英語に倒す
  }

  return 'en';
};

type LanguageValue = {
  language: Language;
  setLanguage: (language: Language) => void;
};

const LanguageContext = createContext<LanguageValue>({ language: 'ja', setLanguage: () => {} });

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(detectLanguage);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 書けなくても、そのセッションのあいだは切り替わっている
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === 'ja' ? 'WebGPU サンプル集 — Three.js + TSL' : 'WebGPU Samples — Three.js + TSL';
  }, [language]);

  const value = useMemo(() => ({ language, setLanguage }), [language, setLanguage]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

export const useLanguage = () => useContext(LanguageContext);

/**
 * 日本語と英語を並べて書けるようにする。
 * キーの表を別に持つより、原文が隣に見えていたほうが崩れにくい。
 */
export const useText = () => {
  const { language } = useLanguage();
  return useCallback(<T,>(ja: T, en: T): T => (language === 'ja' ? ja : en), [language]);
};

/** 言語の切り替えボタン。判定を外したときに直せる逃げ道として、必ずどこかに置く */
export const LanguageToggle: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const { language, setLanguage } = useLanguage();
  return (
    <button
      type="button"
      onClick={() => setLanguage(language === 'ja' ? 'en' : 'ja')}
      aria-label={language === 'ja' ? 'Switch to English' : '日本語に切り替える'}
      style={{
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid rgba(255, 255, 255, 0.16)',
        background: 'rgba(0, 0, 0, 0.45)',
        color: '#f2f4f8',
        font: '12px system-ui, sans-serif',
        letterSpacing: '0.06em',
        cursor: 'pointer',
        ...style
      }}
    >
      {language === 'ja' ? 'EN' : '日本語'}
    </button>
  );
};
