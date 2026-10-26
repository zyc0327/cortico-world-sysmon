/**
 * 生成 describe.json。
 * Cortico checkout 里的 `pnpm describe:extension <dir>` 做同样的事;这里不依赖 checkout。
 * 用法:`pnpm describe`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSMON } from '../src/definition.ts';
import { text } from '../src/strings.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const content = readFileSync(join(root, 'src', 'ENV_PROMPT.md'), 'utf8');
const doc = {
  tools: SYSMON.describe?.tools ?? [],
  events: SYSMON.describe?.events ?? [],
  prompts: [{
    key: 'worlds.sysmon.envPrompt',
    title: text('zh').promptDocTitle,
    role: 'envPrompt',
    content,
  }],
};

writeFileSync(join(root, 'describe.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log('wrote describe.json');
