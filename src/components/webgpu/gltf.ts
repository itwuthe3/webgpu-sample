import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * 同梱の glTF は meshopt で圧縮してある（EXT_meshopt_compression + KHR_mesh_quantization）。
 * 木のモデルは 39MB → 9MB になっているが、デコーダを登録していない GLTFLoader で読むと
 * 「必要な拡張がない」で読み込みに失敗するので、必ずこのローダーを使うこと。
 */
export const createGLTFLoader = (): GLTFLoader => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
