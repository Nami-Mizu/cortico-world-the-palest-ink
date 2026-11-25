/**
 * 用宿主的真实代码做第②级检查：干装载 + 自描述比对。
 *
 * 本机没有装宿主的依赖（`check:extension` 会用到 provider 注册表，牵连 fflate 等），
 * 所以这里只走 World 需要的两条路径：
 *   - `dryMountWorld()`：用默认配置构造、检查工具/事件/环境提示词/面板声明
 *   - `checkDescribe()`：把代码里的 describe 与 describe.json 逐字段比对
 *
 * 用法（宿主源码默认在 ../../cortico，可用 CORTICO_HOST 覆盖）：
 *   node node_modules/tsx/dist/cli.mjs _dev/host-check.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkgDir = resolve(import.meta.dirname, '..');
const hostDir = resolve(process.env.CORTICO_HOST ?? join(pkgDir, '..', '..', 'cortico'));

const host = (relative: string) => import(pathToFileURL(join(hostDir, relative)).href);

const { readTextFile } = (await host('src/core/util.ts')) as {
  readTextFile: (file: string) => string;
};
const { parseExtensionManifest } = (await host('src/extensions/manifest.ts')) as {
  parseExtensionManifest: (pkg: unknown, language: string) => {
    ok: boolean;
    reasons: string[];
    warnings: string[];
    manifest?: Record<string, unknown>;
  };
};
const { registerFrameworkResolver } = (await host('src/extensions/runtime.ts')) as {
  registerFrameworkResolver: () => void;
};
const { dryMountWorld } = (await host('src/extensions/dry-mount.ts')) as {
  dryMountWorld: (
    definition: unknown,
    opts: Record<string, unknown>,
  ) => Promise<{ ok: string[]; warnings: string[]; failures: string[] }>;
};
const { checkDescribe } = (await host('src/extensions/describe-export.ts')) as {
  checkDescribe: (
    kind: string,
    definition: unknown,
    describePath: string | undefined,
    opts: Record<string, unknown>,
  ) => Promise<{ ok: string[]; warnings: string[]; failures: string[] }>;
};
const { isWorldDefinition, resolveExtensionEntry } = (await host('src/extensions.ts')) as {
  isWorldDefinition: (value: unknown) => boolean;
  resolveExtensionEntry: (pkgDir: string, pkg: unknown) => string;
};

let failures = 0;
const fail = (message: string) => {
  failures += 1;
  console.log(`✗ ${message}`);
};
const ok = (message: string) => console.log(`✓ ${message}`);
const warn = (message: string) => console.log(`⚠ ${message}`);

const pkg = JSON.parse(readTextFile(join(pkgDir, 'package.json'))) as Record<string, unknown>;
const parsed = parseExtensionManifest(pkg, 'en');
for (const message of parsed.warnings) warn(message);
if (!parsed.ok || !parsed.manifest) {
  for (const reason of parsed.reasons) fail(reason);
  process.exit(1);
}
const manifest = parsed.manifest as Record<string, unknown>;
ok(`manifest ${String(manifest.kind)} api ${String(manifest.api)}`);

const entry = resolveExtensionEntry(pkgDir, pkg);
registerFrameworkResolver();
const exported = ((await import(pathToFileURL(entry).href)) as { default?: unknown }).default;
if (!isWorldDefinition(exported)) {
  fail('default export is not a WorldDefinition');
  process.exit(1);
}

const scratchDir = mkdtempSync(join(tmpdir(), 'ink-host-check-'));
try {
  const dryOpts = {
    scratchDir,
    packageDir: pkgDir,
    repoRoot: hostDir,
    hasWebUiClient: manifest.webUiClient !== undefined,
    language: 'en' as const,
  };
  const mount = await dryMountWorld(exported, dryOpts);
  for (const message of mount.ok) ok(message);
  for (const message of mount.warnings) warn(message);
  for (const message of mount.failures) fail(message);

  const described = await checkDescribe(
    'world',
    exported,
    manifest.describe as string | undefined,
    dryOpts,
  );
  for (const message of described.ok) ok(message);
  for (const message of described.warnings) warn(message);
  for (const message of described.failures) fail(message);
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'HOST CHECK PASS' : `HOST CHECK FAIL: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
