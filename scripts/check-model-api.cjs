const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.join(__dirname, '..', 'package.json'))('playwright');
const { writeStubClient } = require('./lib/stub-backend.cjs');
const {
  assertMemoryHeadroom,
  installStackCleanup,
  spawnStackProc,
  sweepStaleStackProcesses,
} = require('./lib/suite-stack.cjs');

const PRODUCT_ROOT = path.join(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'model-api-check-'));
const SESSIONS_ROOT = path.join(RUN_ROOT, 'sessions');
const STATES_PATH = path.join(RUN_ROOT, 'states.json');
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeReporter() {
  let failed = false;
  const report = (name, ok, extra = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failed = true;
  };
  return { report, isFailed: () => failed };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function waitHttp(url, label, tries = 40) {
  return (async () => {
    for (let i = 0; i < tries; i++) {
      await delay(500);
      try {
        const res = await new Promise((resolve, reject) => {
          const req = http.get(url, (r) => {
            r.resume();
            resolve(r.statusCode);
          });
          req.on('error', reject);
          req.setTimeout(1500, () => {
            req.destroy();
            reject(new Error('timeout'));
          });
        });
        if (res === 200) return true;
      } catch {}
    }
    throw new Error(`${label} did not come up`);
  })();
}

function writeSessionFile(name) {
  const dir = path.join(SESSIONS_ROOT, '--tmp-model-api--');
  fs.mkdirSync(dir, { recursive: true });
  const id = `019f${Math.random().toString(16).slice(2, 14)}`;
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      cwd: RUN_ROOT,
    }),
    JSON.stringify({
      type: 'message',
      id: `${name}-u0`,
      parentId: id,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: `${name} q0` }], timestamp: Date.now() },
    }),
    JSON.stringify({
      type: 'message',
      id: `${name}-a0`,
      parentId: `${name}-u0`,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${name} answer text` }],
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    }),
  ];
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const STUB_MODELS = [
  {
    id: 'stub-pro',
    provider: 'stub',
    name: 'Stub Pro',
    reasoning: true,
    contextWindow: 1048576,
    maxTokens: 8192,
    api: 'openai-completions',
    baseUrl: 'https://stub.example/v1',
    input: ['text', 'image'],
    thinkingLevels: ['off', 'low', 'high'],
  },
  {
    id: 'stub-mini',
    provider: 'stub',
    name: 'Stub Mini',
    reasoning: false,
    contextWindow: 100000,
    maxTokens: 4096,
    api: 'openai-completions',
    baseUrl: 'https://stub.example/v1',
    input: ['text'],
    thinkingLevels: ['off'],
  },
];

(async () => {
  const { report, isFailed } = makeReporter();
  assertMemoryHeadroom({ label: 'check-model-api' });
  sweepStaleStackProcesses('check-model-api:stack');
  const procs = [];
  const browserRef = { current: null };
  installStackCleanup({ procs, stamp: 'check-model-api:stack', browserRef, label: 'check-model-api' });
  let browser;
  try {
    const backendPort = await freePort();
    const vitePort = await freePort();
    console.log(`stack: backend :${backendPort} vite :${vitePort}`);
    const stub = writeStubClient(RUN_ROOT);
    const sessionFile = writeSessionFile('model-api-check');

    procs.push(
      spawnStackProc(spawn, 'check-model-api:stack', 'node', ['src/pi-studio/server/index.mjs'], {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(backendPort),
          PI_STUDIO_CLIENT_MODULE: stub.stubPath,
          STUB_CONTROL_FILE: stub.controlPath,
          PI_STUDIO_SESSIONS: SESSIONS_ROOT,
          PI_STUDIO_STATES_PATH: STATES_PATH,
          PI_STUDIO_CWD: RUN_ROOT,
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/model-api-check-backend.log', 'a'),
          fs.openSync('/tmp/model-api-check-backend.log', 'a'),
        ],
      }),
    );
    await waitHttp(`http://127.0.0.1:${backendPort}/api/health`, 'backend');
    procs.push(
      spawnStackProc(
        spawn,
        'check-model-api:stack',
        'node',
        [
          'node_modules/.bin/vite',
          '--config',
          'vite.config.ts',
          '--host',
          '127.0.0.1',
          '--port',
          String(vitePort),
        ],
        {
          cwd: PRODUCT_ROOT,
          env: { ...process.env, PI_API_PROXY: `http://127.0.0.1:${backendPort}` },
          stdio: [
            'ignore',
            fs.openSync('/tmp/model-api-check-vite.log', 'a'),
            fs.openSync('/tmp/model-api-check-vite.log', 'a'),
          ],
        },
      ),
    );
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 'vite');

    browser = await chromium.launch();
    browserRef.current = browser;
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('503')) errors.push(`console: ${m.text()}`);
    });

    const state = {
      currentId: 'stub-mini',
      currentName: 'Stub Mini',
      currentLevel: 'off',
      defaultId: 'stub-mini',
      explicit: true,
      defLevel: null,
      latestChatId: 'stub-pro',
      posts: [],
      gets: [],
    };
    await page.route('**/api/models*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        state.posts.push(body);
        if (body.model === 'stub/stub-pro' && body.thinkLevel === 'high') {
          state.currentId = 'stub-pro';
          state.currentName = 'Stub Pro';
          state.currentLevel = 'high';
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, notice: 'Model: stub/Stub Pro · Thinking: high' }),
        });
        return;
      }
      const file = url.searchParams.get('file');
      state.gets.push(file || '');
      const current = file ? (STUB_MODELS.find((m) => m.id === state.currentId) ?? null) : null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: STUB_MODELS,
          default: STUB_MODELS.find((m) => m.id === state.defaultId) ?? null,
          defaultSource: state.explicit ? 'settings' : 'latest-chat',
          defaultThinkingLevel: state.defLevel ?? null,
          current,
          currentThinkingLevel: file ? state.currentLevel : null,
        }),
      });
    });

    await page.goto(`http://127.0.0.1:${vitePort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sf-docker', { timeout: 60000 });

    const itemSel = '.chat-list-item:has-text("model-api-check")';
    await page.waitForSelector(itemSel, { timeout: 60000 });
    await delay(1000);
    await page.locator(itemSel).first().click({ force: true });
    await page.waitForSelector('.chat-msg', { timeout: 20000 });
    report('chat window opens with message content', true);

    await page.waitForSelector('.model-menu', { timeout: 10000 });
    const modelRow = (key) => page.locator(`.model-menu .kv-row:has(.kv-key:text-is("${key}")) .kv-value`);
    await modelRow('Model').waitFor({ timeout: 10000 });
    const beforeProvider = await modelRow('Provider').textContent();
    const beforeModel = await modelRow('Model').textContent();
    const beforeThinking = await modelRow('Thinking').textContent();
    report(
      'session model view loads from GET /api/models?file=',
      beforeProvider === 'stub' && beforeModel === 'Stub Mini' && beforeThinking === '(None)',
      `${beforeProvider}/${beforeModel}/${beforeThinking}`,
    );

    await page.locator('.model-menu-btn').click();
    await page.waitForSelector('.sf-menu-pop', { timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'stub' }).hover();
    await page.locator('.sf-menu-row', { hasText: 'Stub Pro' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Stub Pro' }).hover();
    await page.locator('.sf-menu-row', { hasText: 'high' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'high' }).click();
    await delay(500);

    const post = state.posts[state.posts.length - 1];
    report(
      'switching model POSTs provider/id + thinkLevel to /api/models',
      !!post && post.file === sessionFile && post.model === 'stub/stub-pro' && post.thinkLevel === 'high',
      post ? JSON.stringify({ model: post.model, thinkLevel: post.thinkLevel }) : 'no POST seen',
    );

    await modelRow('Model').filter({ hasText: 'Stub Pro' }).waitFor({ timeout: 10000 });
    const afterModel = await modelRow('Model').textContent();
    const afterThinking = await modelRow('Thinking').textContent();
    report(
      'picker reflects the applied model after POST',
      afterModel === 'Stub Pro' && afterThinking === 'high',
      `${afterModel}/${afterThinking}`,
    );

    const input = page.locator('.chat-input');
    await input.click();
    await input.fill('/');
    await delay(600);
    const completions = await page.locator('.chat-completions').count();
    const pickerOverlay = await page.locator('.chat-picker').count();
    report('typing / no longer opens a slash completion popup', completions === 0 && pickerOverlay === 0);

    await input.fill('/model stub/stub-pro');
    await input.press('Enter');
    await delay(800);
    const postsAfterSlash = state.posts.length;
    report(
      'slash text is sent as a plain message, not executed',
      postsAfterSlash === 1,
      `posts=${postsAfterSlash}`,
    );

    let refreshCalls = 0;
    await page.route('**/api/models/refresh', async (route) => {
      refreshCalls += 1;
      state.currentId = 'stub-mini';
      state.defaultId = 'stub-pro';
      state.explicit = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: STUB_MODELS,
          default: STUB_MODELS[0],
          defaultSource: 'settings',
          defaultThinkingLevel: state.defLevel ?? null,
          current: null,
          currentThinkingLevel: null,
          errors: [],
        }),
      });
    });

    const defaultPosts = [];
    await page.route('**/api/models/default', async (route) => {
      const body = route.request().postDataJSON();
      defaultPosts.push(body);
      if (body.model === null) {
        state.explicit = false;
        state.defaultId = state.latestChatId;
      } else {
        state.explicit = true;
        state.defaultId = String(body.model).split('/').pop();
        if (body.thinkLevel) state.defLevel = body.thinkLevel;
      }
      const hit = STUB_MODELS.find((m) => m.id === state.defaultId) ?? null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: STUB_MODELS,
          default: hit,
          defaultSource: state.explicit ? 'settings' : 'latest-chat',
          defaultThinkingLevel: state.defLevel ?? null,
          current: null,
          currentThinkingLevel: null,
          errors: [],
        }),
      });
    });

    await page.locator('.sf-menu-item', { hasText: 'Model' }).click();
    await page.locator('.sf-menu-row', { hasText: 'Refresh Catalog' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Refresh Catalog' }).click();
    await delay(800);
    report(
      'Model menu Refresh Catalog POSTs /api/models/refresh',
      refreshCalls === 1,
      `refreshCalls=${refreshCalls}`,
    );

    await page.locator('.sf-menu-item', { hasText: 'Model' }).click();
    await page.locator('.sf-menu-row', { hasText: 'Model Catalog…' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Model Catalog…' }).click();
    await page.waitForSelector('.model-catalog', { timeout: 10000 });
    await page.locator('.model-catalog-row', { hasText: 'Stub Pro' }).first().waitFor({ timeout: 5000 });
    const catalogGroups = await page.locator('.model-catalog-group').count();
    const catalogRows = await page.locator('.model-catalog-row').count();
    const defaultBadge = await page.locator('.model-catalog-badge').count();
    report(
      'Model Catalog window lists models grouped by provider with default badge',
      catalogGroups === 1 && catalogRows === 2 && defaultBadge === 1,
      `groups=${catalogGroups} rows=${catalogRows} badges=${defaultBadge}`,
    );

    const themed = await page.evaluate(() => {
      const input = document.querySelector('.model-catalog-filter');
      const btn = document.querySelector('.model-catalog-refresh');
      if (!input || !btn) return null;
      const si = getComputedStyle(input);
      const sb = getComputedStyle(btn);
      return {
        inputBg: si.backgroundColor,
        inputBorder: si.borderTopWidth !== '0px' && si.borderTopStyle !== 'none',
        btnBorder: sb.borderTopWidth !== '0px' && sb.borderTopStyle !== 'none',
        btnBg: sb.backgroundColor,
      };
    });
    report(
      'filter input and refresh button use theme colors and borders',
      !!themed &&
        themed.inputBg === 'rgb(30, 30, 30)' &&
        themed.inputBorder &&
        themed.btnBorder &&
        themed.btnBg !== 'rgba(0, 0, 0, 0)',
      themed ? JSON.stringify(themed) : 'controls not found',
    );

    const idCols = await page.locator('.model-catalog-id').count();
    report('redundant model id column removed', idCols === 0, `idCols=${idCols}`);

    const levelsCols = await page.locator('.model-catalog-levels').count();
    const proRow = await page.locator('.model-catalog-row', { hasText: 'Stub Pro' }).first().textContent();
    const miniRow = await page.locator('.model-catalog-row', { hasText: 'Stub Mini' }).first().textContent();
    report(
      'catalog rows show name, context, input type, cost only — levels moved to the detail panel',
      levelsCols === 0 &&
        !!proRow &&
        proRow.includes('text + image') &&
        proRow.includes('1,049k') &&
        proRow.indexOf('text + image') < proRow.indexOf('1,049k') &&
        !proRow.includes('low, high') &&
        !!miniRow &&
        miniRow.includes('text') &&
        !miniRow.includes('off'),
      `levelsCols=${levelsCols} pro=${proRow ? proRow.slice(0, 60) : '?'}`,
    );

    const aligns = await page.evaluate(() => {
      const row = document.querySelector('.model-catalog-row');
      if (!row) return null;
      const get = (sel) => {
        const el = row.querySelector(sel);
        return el ? getComputedStyle(el).textAlign : null;
      };
      return {
        name: get('.model-catalog-name'),
        input: get('.model-catalog-input'),
        ctx: get('.model-catalog-ctx'),
        cost: get('.model-catalog-cost'),
      };
    });
    report(
      'catalog cells right-aligned except model name',
      !!aligns &&
        aligns.name === 'start' &&
        aligns.input === 'right' &&
        aligns.ctx === 'right' &&
        aligns.cost === 'right',
      aligns ? JSON.stringify(aligns) : 'no row',
    );

    await page.locator('.model-catalog-group-head').click();
    await delay(300);
    const rowsCollapsed = await page.locator('.model-catalog-row').count();
    await page.locator('.model-catalog-group-head').click();
    await delay(300);
    const rowsExpanded = await page.locator('.model-catalog-row').count();
    report(
      'provider group collapses and expands from its banner',
      rowsCollapsed === 0 && rowsExpanded === 2,
      `collapsed=${rowsCollapsed} expanded=${rowsExpanded}`,
    );

    await page.locator('.model-catalog-filter').fill('mini');
    await delay(300);
    const filteredRows = await page.locator('.model-catalog-row').count();
    report('catalog filter narrows the list', filteredRows === 1, `rows=${filteredRows}`);
    await page.locator('.model-catalog-filter').fill('');
    await delay(300);

    const detailHint = await page.locator('.model-detail-hint').count();
    report('model detail panel shows hint before selection', detailHint === 1, `hint=${detailHint}`);

    await page.locator('.model-catalog-row', { hasText: 'Stub Pro' }).first().click();
    await delay(400);
    const detailText = (await page.locator('.model-detail').textContent()) ?? '';
    const detailPill = await page.locator('.model-detail .kv-pill--ok').count();
    report(
      'clicking a catalog row shows full metadata in the right panel',
      detailText.includes('stub-pro') &&
        detailText.includes('openai-completions') &&
        detailText.includes('https://stub.example/v1') &&
        detailText.includes('1,049k') &&
        detailText.includes('8,192') &&
        detailText.includes('text + image') &&
        detailPill === 1,
      `pill=${detailPill} text=${detailText.slice(0, 80)}`,
    );

    const rightTitle = (await page.locator('.sf-panel--right .sf-panel-title').textContent()) ?? '';
    report(
      'right panel uses the model-catalog layout while the catalog tab is focused',
      rightTitle.trim() === 'Model Catalog',
      `title=${rightTitle}`,
    );

    await page.locator('.sf-tab-label', { hasText: 'model-api-check' }).first().click({ force: true });
    await delay(400);
    const chatTitle = (await page.locator('.sf-panel--right .sf-panel-title').textContent()) ?? '';
    const chatDetail = await page.locator('.model-detail').count();
    await page.locator('.sf-tab-label', { hasText: 'Model Catalog' }).first().click({ force: true });
    await delay(400);
    const backTitle = (await page.locator('.sf-panel--right .sf-panel-title').textContent()) ?? '';
    const backDetail = (await page.locator('.model-detail').textContent()) ?? '';
    report(
      'right panel follows the focused tab: chat layout on chat tabs, catalog layout on catalog',
      chatTitle.trim() === 'Chat' &&
        chatDetail === 0 &&
        backTitle.trim() === 'Model Catalog' &&
        backDetail.includes('stub-pro'),
      `chatTitle=${chatTitle} chatDetail=${chatDetail} backTitle=${backTitle}`,
    );

    await page.locator('.model-catalog-row', { hasText: 'Stub Mini' }).first().click();
    await delay(400);
    const miniSwitchBefore = await page.locator('.model-detail .md-switch').getAttribute('aria-checked');
    await page.locator('.model-detail .md-switch').click();
    await delay(600);
    const togglePost = defaultPosts[defaultPosts.length - 1];
    const badgeRow = await page.locator('.model-catalog-row:has(.model-catalog-badge)').first().textContent();
    const miniSwitchAfter = await page.locator('.model-detail .md-switch').getAttribute('aria-checked');
    const miniPills = await page.locator('.model-detail-pill').count();
    const srcNote = await page.locator('.model-detail-src').count();
    report(
      'default-model toggle in the detail panel POSTs provider/id and moves the badge',
      miniSwitchBefore === 'false' &&
        !!togglePost &&
        togglePost.model === 'stub/stub-mini' &&
        togglePost.thinkLevel === undefined &&
        !!badgeRow &&
        badgeRow.includes('Stub Mini') &&
        miniSwitchAfter === 'true' &&
        miniPills === 1 &&
        srcNote === 0,
      `before=${miniSwitchBefore} post=${JSON.stringify(togglePost)} badge=${badgeRow ? (badgeRow.includes('Stub Mini') ? 'Mini' : 'other') : '?'} after=${miniSwitchAfter} pills=${miniPills}`,
    );

    await page.locator('.model-catalog-row', { hasText: 'Stub Pro' }).first().click();
    await delay(400);
    await page.locator('.model-detail .md-switch').click();
    await delay(600);
    const proPills = await page.locator('.model-detail-pill').count();
    const activeBefore = await page.locator('.model-detail-pill--on').textContent();
    await page.locator('.model-detail-pill', { hasText: 'high' }).click();
    await delay(600);
    const levelPost = defaultPosts[defaultPosts.length - 1];
    const activeAfter = await page.locator('.model-detail-pill--on').textContent();
    report(
      'thinking-level pills POST thinkLevel with the default model and mark the active level',
      proPills === 3 &&
        !!levelPost &&
        levelPost.model === 'stub/stub-pro' &&
        levelPost.thinkLevel === 'high' &&
        (activeAfter ?? '').trim() === 'high' &&
        (activeBefore ?? '').trim() !== 'high',
      `pills=${proPills} post=${JSON.stringify(levelPost)} active=${activeBefore}->${activeAfter}`,
    );

    await page.locator('.model-detail .md-switch').click();
    await delay(600);
    const clearPost = defaultPosts[defaultPosts.length - 1];
    const clearBadge = await page
      .locator('.model-catalog-row:has(.model-catalog-badge)')
      .first()
      .textContent();
    const clearSwitch = await page.locator('.model-detail .md-switch').getAttribute('aria-checked');
    const clearSrc = await page.locator('.model-detail-src').textContent();
    report(
      'unsetting the default POSTs null and falls back to the latest-chat model',
      !!clearPost &&
        clearPost.model === null &&
        !!clearBadge &&
        clearBadge.includes('Stub Pro') &&
        clearSwitch === 'true' &&
        (clearSrc ?? '').includes('via latest new chat'),
      `post=${JSON.stringify(clearPost)} badge=${clearBadge ? (clearBadge.includes('Stub Pro') ? 'Pro' : 'other') : '?'} switch=${clearSwitch} src=${clearSrc}`,
    );

    await page.locator('.sf-tab-label', { hasText: 'model-api-check' }).first().click({ force: true });
    await delay(400);
    await page.locator('.sf-menu-item', { hasText: 'Model' }).click();
    await page.locator('.sf-menu-row', { hasText: 'Change Model…' }).waitFor({ timeout: 5000 });
    await page.locator('.sf-menu-row', { hasText: 'Change Model…' }).click();
    await delay(600);
    const pickerOpen = await page.locator('.model-menu .sf-menu-pop').count();
    report(
      'Change Model… opens the right-panel model picker menu',
      pickerOpen === 1,
      `pickerPops=${pickerOpen}`,
    );
    await page.keyboard.press('Escape');

    const sdkPort = await freePort();
    const sdkSessions = path.join(RUN_ROOT, 'sdk-sessions');
    const sdkStates = path.join(RUN_ROOT, 'sdk-states.json');
    const agentHome = path.join(RUN_ROOT, 'agent-home');
    fs.mkdirSync(sdkSessions, { recursive: true });
    fs.mkdirSync(agentHome, { recursive: true });
    const settingsFile = path.join(agentHome, 'settings.json');
    const sdkBackend = spawnStackProc(
      spawn,
      'check-model-api:stack',
      'node',
      ['src/pi-studio/server/index.mjs'],
      {
        cwd: PRODUCT_ROOT,
        env: {
          ...process.env,
          PI_STUDIO_PORT: String(sdkPort),
          PI_STUDIO_HOST: '127.0.0.1',
          PI_STUDIO_SESSIONS: sdkSessions,
          PI_STUDIO_CWD: RUN_ROOT,
          PI_STUDIO_STATES_PATH: sdkStates,
          PI_STUDIO_DB_PATH: path.join(RUN_ROOT, 'sdk-studio.db'),
          PI_STUDIO_SPILL_PATH: path.join(RUN_ROOT, 'sdk-spill.json'),
          PI_SDK_DIR: path.join(PRODUCT_ROOT, 'scripts', 'lib', 'stub-sdk'),
          PI_CODING_AGENT_DIR: agentHome,
          STUB_STATE_DIR: path.join(RUN_ROOT, 'sdk-stub-state'),
        },
        stdio: [
          'ignore',
          fs.openSync('/tmp/model-api-check-sdk-backend.log', 'a'),
          fs.openSync('/tmp/model-api-check-sdk-backend.log', 'a'),
        ],
      },
    );
    procs.push(sdkBackend);
    await waitHttp(`http://127.0.0.1:${sdkPort}/api/health`, 'sdk backend');
    const jfetch = async (p, opts) => {
      const r = await fetch(`http://127.0.0.1:${sdkPort}${p}`, opts);
      return { status: r.status, body: await r.json() };
    };

    let r = await jfetch('/api/models');
    report(
      'server default resolution: fallback when no settings and no chat history',
      r.status === 200 &&
        r.body.models?.length === 2 &&
        r.body.default?.id === 'stub-pro' &&
        r.body.defaultSource === 'fallback' &&
        r.body.defaultThinkingLevel === null,
      JSON.stringify({ status: r.status, def: r.body.default?.id, src: r.body.defaultSource }),
    );

    fs.writeFileSync(
      settingsFile,
      `${JSON.stringify({ defaultProvider: 'stub', defaultModel: 'stub-mini', defaultThinkingLevel: 'low' }, null, 2)}\n`,
    );
    r = await jfetch('/api/models');
    report(
      'server default resolution: explicit settings win',
      r.body.default?.id === 'stub-mini' &&
        r.body.defaultSource === 'settings' &&
        r.body.defaultThinkingLevel === 'low',
      JSON.stringify({
        def: r.body.default?.id,
        src: r.body.defaultSource,
        lvl: r.body.defaultThinkingLevel,
      }),
    );

    r = await jfetch('/api/models/default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'stub/stub-pro', thinkLevel: 'high' }),
    });
    const afterSet = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    report(
      'POST /api/models/default persists model and thinking level to settings',
      r.status === 200 &&
        afterSet.defaultProvider === 'stub' &&
        afterSet.defaultModel === 'stub-pro' &&
        afterSet.defaultThinkingLevel === 'high' &&
        r.body.default?.id === 'stub-pro' &&
        r.body.defaultThinkingLevel === 'high',
      JSON.stringify({ status: r.status, settings: afterSet }),
    );

    const safeCwd = `--${RUN_ROOT.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}`;
    const chatDir = path.join(sdkSessions, safeCwd);
    fs.mkdirSync(chatDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const chatFile = path.join(chatDir, `${ts}_00000000-0000-4000-8000-000000000001.jsonl`);
    fs.writeFileSync(
      chatFile,
      `${JSON.stringify({
        type: 'message',
        id: 'latest-a0',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'latest chat answer' }],
          provider: 'stub',
          model: 'stub-mini',
          timestamp: Date.now(),
          stopReason: 'stop',
        },
      })}\n`,
    );
    r = await jfetch('/api/models/default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: null }),
    });
    const afterClear = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    r = await jfetch('/api/models');
    report(
      'clearing the default falls back to the latest-chat model',
      r.body.default?.id === 'stub-mini' &&
        r.body.defaultSource === 'latest-chat' &&
        !('defaultModel' in afterClear) &&
        !('defaultProvider' in afterClear),
      JSON.stringify({ def: r.body.default?.id, src: r.body.defaultSource, settings: afterClear }),
    );

    r = await jfetch('/api/new-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: RUN_ROOT }),
    });
    const newFile = r.body.file;
    r = await jfetch(`/api/models?file=${encodeURIComponent(newFile)}`);
    report(
      'a new chat inherits the implicit latest-chat default',
      r.body.current?.id === 'stub-mini' && r.body.defaultSource === 'latest-chat',
      JSON.stringify({ current: r.body.current?.id, src: r.body.defaultSource }),
    );

    report('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
  } catch (e) {
    console.error('check-model-api crashed:', e);
    process.exitCode = 1;
  } finally {
    if (browserRef.current) await browserRef.current.close().catch(() => {});
    for (const p of procs) {
      try {
        if (p.exitCode === null) process.kill(-p.pid, 'SIGTERM');
      } catch {}
    }
    await delay(500);
  }
  if (isFailed() || process.exitCode) process.exitCode = 1;
})();
