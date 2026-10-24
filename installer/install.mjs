#!/usr/bin/env node
// ST-Background-Reply server plugin installer.
//
//   node install.mjs                 install / update the plugin and enable server plugins
//   node install.mjs --uninstall     remove the plugin folder (config.yaml is left as is)
//   node install.mjs --st <path>     SillyTavern folder, if it can't be found automatically
//
// Every file is backed up before it is changed or replaced.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'st-bg-reply';
const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const pluginSource = path.join(extensionRoot, 'server-plugin');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const stArgIndex = args.indexOf('--st');
const stArg = stArgIndex >= 0 ? args[stArgIndex + 1] : null;

const ok = (msg) => console.log(`  [OK] ${msg}`);
const info = (msg) => console.log(`  - ${msg}`);
const warn = (msg) => console.log(`  [!] ${msg}`);

function isSillyTavernRoot(dir) {
    try {
        if (!fs.existsSync(path.join(dir, 'server.js'))) return false;
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return String(pkg.name).toLowerCase() === 'sillytavern';
    } catch {
        return false;
    }
}

function findSillyTavernRoot() {
    if (stArg) return isSillyTavernRoot(path.resolve(stArg)) ? path.resolve(stArg) : null;
    const starts = [extensionRoot, process.cwd()];
    for (const start of starts) {
        let dir = start;
        for (let i = 0; i < 12; i++) {
            if (isSillyTavernRoot(dir)) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return null;
}

function listFiles(dir, base = dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(full, base));
        else out.push(path.relative(base, full));
    }
    return out.sort();
}

function sameTree(a, b) {
    if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
    const fa = listFiles(a);
    const fb = listFiles(b);
    if (fa.join('\n') !== fb.join('\n')) return false;
    return fa.every(f => fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))));
}

function backupDir(root) {
    const dir = path.join(root, 'backups', `${PLUGIN_ID}-plugin`, stamp);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function configCandidates(root) {
    return [path.join(root, 'config.yaml'), path.join(root, 'config', 'config.yaml')].filter(f => fs.existsSync(f));
}

function enableServerPlugins(file) {
    const text = fs.readFileSync(file, 'utf8');
    if (/^enableServerPlugins:\s*true\b/m.test(text)) {
        ok(`${path.basename(path.dirname(file)) === 'config' ? 'config/config.yaml' : 'config.yaml'}: enableServerPlugins 이미 true`);
        return false;
    }
    const backup = `${file}.bak-${PLUGIN_ID}-${stamp}`;
    fs.copyFileSync(file, backup);
    info(`config 백업: ${backup}`);
    let next;
    if (/^enableServerPlugins:.*$/m.test(text)) {
        next = text.replace(/^enableServerPlugins:[^\r\n]*/m, 'enableServerPlugins: true');
    } else {
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        next = text + (text.endsWith('\n') ? '' : eol) + `# Added by ${PLUGIN_ID} installer${eol}enableServerPlugins: true${eol}`;
    }
    fs.writeFileSync(file, next);
    ok(`${file}: enableServerPlugins: true 로 변경`);
    return true;
}

function main() {
    console.log('');
    console.log(`ST-Background-Reply 서버 플러그인 ${uninstall ? '제거' : '설치'}`);
    console.log('------------------------------------------------------------');

    const root = findSillyTavernRoot();
    if (!root) {
        warn('SillyTavern 폴더를 찾지 못했어요.');
        warn('이 확장이 SillyTavern 폴더 안(data/<사용자>/extensions 또는 public/scripts/extensions/third-party)에 있는지 확인하거나,');
        warn('직접 지정하세요:  node install.mjs --st "C:\\경로\\SillyTavern"');
        return 1;
    }
    info(`SillyTavern 폴더: ${root}`);

    const pluginsDir = path.join(root, 'plugins');
    const target = path.join(pluginsDir, PLUGIN_ID);

    if (uninstall) {
        if (!fs.existsSync(target)) {
            ok('플러그인이 설치되어 있지 않아요.');
            return 0;
        }
        const backup = path.join(backupDir(root), PLUGIN_ID);
        fs.cpSync(target, backup, { recursive: true });
        info(`기존 플러그인 백업: ${backup}`);
        fs.rmSync(target, { recursive: true, force: true });
        ok('plugins/st-bg-reply 제거 완료. SillyTavern을 재시작하세요.');
        info('config.yaml 의 enableServerPlugins 는 다른 플러그인을 위해 그대로 두었어요.');
        return 0;
    }

    if (!fs.existsSync(path.join(pluginSource, 'index.mjs'))) {
        warn(`플러그인 원본이 없어요: ${pluginSource}`);
        return 1;
    }

    fs.mkdirSync(pluginsDir, { recursive: true });
    let changed = false;
    if (sameTree(pluginSource, target)) {
        ok('plugins/st-bg-reply: 이미 최신이에요.');
    } else {
        if (fs.existsSync(target)) {
            const backup = path.join(backupDir(root), PLUGIN_ID);
            fs.cpSync(target, backup, { recursive: true });
            info(`기존 플러그인 백업: ${backup}`);
            fs.rmSync(target, { recursive: true, force: true });
        }
        fs.cpSync(pluginSource, target, { recursive: true });
        ok(`플러그인 복사: ${target}`);
        changed = true;
    }

    const configs = configCandidates(root);
    if (configs.length === 0) {
        warn('config.yaml 이 아직 없어요. SillyTavern을 한 번 실행해서 config.yaml 을 만든 뒤 이 스크립트를 다시 실행하세요.');
    }
    for (const file of configs) {
        if (enableServerPlugins(file)) changed = true;
    }
    const envValue = process.env.SILLYTAVERN_ENABLESERVERPLUGINS;
    if (envValue !== undefined && String(envValue).toLowerCase() !== 'true') {
        warn(`환경 변수 SILLYTAVERN_ENABLESERVERPLUGINS=${envValue} 가 config.yaml 보다 우선해요. true 로 바꿔 주세요.`);
    }

    console.log('');
    if (changed) {
        console.log('  완료! SillyTavern을 재시작하면 적용돼요. (서버 창을 닫고 다시 실행)');
    } else {
        console.log('  바뀐 것이 없어요. 플러그인이 안 잡히면 SillyTavern을 재시작해 보세요.');
    }
    console.log('  확인: 확장 설정 → 백그라운드 답장 에 "서버 플러그인 연결됨" 이 보이면 성공이에요.');
    console.log('');
    return 0;
}

try {
    process.exitCode = main();
} catch (error) {
    console.error('  [!] 설치 중 오류:', error?.message || error);
    process.exitCode = 1;
}
