/** 面板入口：宿主按 manifest 的 `webUiClient` 加载这个 bundle。 */
import type { WebUiClientBundle } from 'cortico/web/shared/client-panel.ts';
import embedding from './panels/embedding.ts';
import library from './panels/library.ts';
import starmap from './panels/starmap.ts';
import data from './panels/data.ts';

const bundle: WebUiClientBundle = {
  panels: { library, starmap, embedding, data },
};

export default bundle;
