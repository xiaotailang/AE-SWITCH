import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.env.AE_WORKSPACE ?? process.cwd();
const output = path.join(root, '.cache', 'research');
await fs.mkdir(output, { recursive: true });
const sources = {
  claude: 'https://raw.githubusercontent.com/anthropics/claude-code/main/README.md',
  hermes: 'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md',
  ohmypi: 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/README.md',
  opencode: 'https://raw.githubusercontent.com/anomalyco/opencode/dev/README.md',
  zcodeSearch: 'https://api.github.com/search/repositories?q=zcode+ai+coding&per_page=5',
};
await Promise.all(Object.entries(sources).map(async ([id, url]) => {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'AE-Switch-Compatibility-Research' } });
    const text = await response.text();
    await fs.writeFile(path.join(output, `${id}.txt`), text);
    if (id === 'zcodeSearch') {
      const data = JSON.parse(text);
      console.log(JSON.stringify({ id, status: response.status, repositories: data.items?.map(x => ({ name: x.full_name, description: x.description })) }));
    } else {
      console.log(JSON.stringify({ id, status: response.status, excerpts: text.split('\n').filter(line => /npm|pip|uv |install|Windows|ANTHROPIC_BASE_URL|API_KEY|custom|headless|print|models.json|config\.yaml|base_url|provider/i.test(line)).slice(0, 50) }));
    }
  } catch (error) {
    console.log(JSON.stringify({ id, error: error.message }));
  }
}));
