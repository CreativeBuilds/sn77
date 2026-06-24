import { promises as fs } from 'fs';
import path from 'path';

export const ENV_PATH = path.join(process.cwd(), '.env');
export const ENV_EXAMPLE_PATH = path.join(process.cwd(), '.env.example');

export const upsertEnvVar = async (key: string, value: string, filePath = ENV_PATH): Promise<void> => {
  let content = '';
  try { content = await fs.readFile(filePath, 'utf8'); }
  catch { content = (await fs.readFile(ENV_EXAMPLE_PATH, 'utf8').catch(() => '')).trim(); }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  content = re.test(content) ? content.replace(re, line) : `${content.trimEnd()}${content ? '\n' : ''}${line}\n`;
  await fs.writeFile(filePath, content);
};
