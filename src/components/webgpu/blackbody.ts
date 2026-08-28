import { clamp, log, max, pow, vec3 } from 'three/tsl';

/** TSL のノードは型が複雑なので、シェーダー組み立て用ヘルパーの引数はこの別名で受ける */
type TSLNode = any;

/**
 * 色温度[K]から RGB。Planck の放射式を CIE で積分した結果への、よく使われる近似
 * （6600K 以下では赤成分は常に飽和しているので、ここでは常に 1.0）。
 *
 * 係数は sRGB 値なので、リニア空間で扱うためにガンマを戻している。**戻さないと黄色すぎる。**
 *
 * 明るさは含まれない。放射輝度は Stefan–Boltzmann で T^4 に効くので、
 * `pow(T / 基準温度, 4)` を呼び出し側で掛けること。炎の先端が白く見えるのは
 * 「白い色」があるからではなく、そこが最も明るくトーンマッピングが飽和するから。
 */
export const blackbodyColor = (kelvin: TSLNode): TSLNode => {
  const t = kelvin.div(100.0);
  const g = clamp(log(t).mul(99.4708).sub(161.1196).div(255.0), 0.0, 1.0);
  const b = clamp(log(max(t.sub(10.0), 0.001)).mul(138.5177).sub(305.0448).div(255.0), 0.0, 1.0);
  return vec3(1.0, pow(g, 2.2), pow(b, 2.2));
};
