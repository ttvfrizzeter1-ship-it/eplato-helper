import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config.json');
const ANSWERS_PATH = path.join(ROOT, 'answers.json');
const OBSERVED_PATH = path.join(ROOT, 'data', 'observed-questions.json');
const DEBUG_DIR = path.join(ROOT, 'data', 'debug');

const UI = {
  disciplines: '\u0414\u0438\u0441\u0446\u0438\u043f\u043b\u0456\u043d\u0438',
  progressStats: '\u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0430 \u043f\u0440\u043e\u0445\u043e\u0434\u0436\u0435\u043d\u043d\u044f',
  interactivePresentation: '\u0406\u043d\u0442\u0435\u0440\u0430\u043a\u0442\u0438\u0432\u043d\u0430 \u043f\u0440\u0435\u0437\u0435\u043d\u0442\u0430\u0446\u0456\u044f',
  topicTest: '\u0422\u0435\u0441\u0442\u0443\u0432\u0430\u043d\u043d\u044f \u043f\u043e \u0442\u0435\u043c\u0456',
  startTesting: '\u0420\u043e\u0437\u043f\u043e\u0447\u0430\u0442\u0438 \u0442\u0435\u0441\u0442\u0443\u0432\u0430\u043d\u043d\u044f',
  beginTesting: '\u041f\u043e\u0447\u0430\u0442\u0438 \u0442\u0435\u0441\u0442\u0443\u0432\u0430\u043d\u043d\u044f',
  start: '\u0420\u043e\u0437\u043f\u043e\u0447\u0430\u0442\u0438',
  begin: '\u041f\u043e\u0447\u0430\u0442\u0438',
  next: '\u041d\u0430\u0441\u0442\u0443\u043f\u043d\u0438\u0439',
  nextNeuter: '\u041d\u0430\u0441\u0442\u0443\u043f\u043d\u0435',
  further: '\u0414\u0430\u043b\u0456',
  submitAnswer: '\u0412\u0456\u0434\u043f\u0440\u0430\u0432\u0438\u0442\u0438 \u0432\u0456\u0434\u043f\u043e\u0432\u0456\u0434\u044c',
  submit: '\u0412\u0456\u0434\u043f\u0440\u0430\u0432\u0438\u0442\u0438',
  save: '\u0417\u0431\u0435\u0440\u0435\u0433\u0442\u0438',
  presentationDone: '\u0412\u0438 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043b\u0438 \u043f\u0435\u0440\u0435\u0433\u043b\u044f\u0434 \u043f\u0440\u0435\u0437\u0435\u043d\u0442\u0430\u0446\u0456\u0457',
  lastSlide: '\u043e\u0441\u0442\u0430\u043d\u043d\u0456\u0439 \u0441\u043b\u0430\u0439\u0434',
  please: '\u0431\u0443\u0434\u044c \u043b\u0430\u0441\u043a\u0430',
  choose: '\u0432\u0438\u0431\u0435\u0440\u0456\u0442\u044c',
  correctPrefix: '\u043f\u0440\u0430\u0432\u0438\u043b\u044c\u043d',
  sendAnswerLower: '\u0432\u0456\u0434\u043f\u0440\u0430\u0432\u0438\u0442\u0438 \u0432\u0456\u0434\u043f\u043e\u0432\u0456\u0434\u044c'
};

const DEFAULT_CONFIG = {
  startUrl: 'https://ez.pdmu.edu.ua/eAristoStudent/subjects',
  profileDir: '.browser-profile',
  headless: false,
  mode: 'manual',
  autoSubmit: false,
  presentationMaxSlides: 250,
  slowMoMs: 0,
  ai: {
    provider: 'openai',
    openaiApi: 'responses',
    openaiModel: 'gpt-5-mini',
    geminiModel: 'gemini-2.5-flash',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen2.5:3b',
    retries: 2,
    timeoutMs: 45000
  },
  timeouts: {
    pageMs: 30000,
    afterClickMs: 250
  }
};

const rl = createInterface({ input, output });
let lastQuestion = null;

function normalizeText(value) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripOptionNumber(value) {
  return normalizeText(value).replace(/^\d+\s*[\).:-]?\s*/, '');
}

function parseNumberList(input) {
  const value = normalizeText(input).toLowerCase();
  if (value === 'all') return 'all';
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((item) => Number.parseInt(item, 10))
        .filter((number) => Number.isInteger(number) && number > 0)
    )
  ];
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    console.warn(`Warning: could not parse ${file}; using fallback. ${error.message}`);
    return fallback;
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitAfterClick(page, config) {
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
  await sleep(config.timeouts.afterClickMs);
}

async function withRetries(label, attempts, fn) {
  let lastError;
  for (let index = 0; index <= attempts; index += 1) {
    try {
      return await fn(index);
    } catch (error) {
      lastError = error;
      if (index < attempts) await sleep(800 * (index + 1));
    }
  }
  throw new Error(`${label} failed: ${lastError?.message || lastError}`);
}

async function retryAction(label, fn, attempts = 2) {
  return withRetries(label, attempts, async () => {
    const result = await fn();
    if (!result) throw new Error('action returned false');
    return result;
  }).catch(() => false);
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonObject(text) {
  const cleaned = normalizeText(text).replace(/^```json\s*/i, '').replace(/```$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`AI response did not contain JSON: ${text}`);
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function buildAiPrompt(questionData) {
  const options = questionData.options.map((option, index) => `${index + 1}. ${option.text}`).join('\n');
  return `Choose the most likely correct answer. Return only valid JSON:
{"answerNumbers":[1],"answerTexts":["exact option text"],"confidence":0.0,"explanation":"short reason"}

Question:
${questionData.question}

Options:
${options}`;
}

async function askOpenAi(config, prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  if ((config.ai.openaiApi || 'responses').toLowerCase() === 'chat') {
    const chatData = await fetchJsonWithTimeout(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.ai.openaiModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0
        })
      },
      config.ai.timeoutMs
    );

    return extractJsonObject(chatData.choices?.[0]?.message?.content || '');
  }

  const data = await fetchJsonWithTimeout(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.ai.openaiModel,
        input: prompt
      })
    },
    config.ai.timeoutMs
  );

  const text =
    data.output_text ||
    data.output
      ?.flatMap((item) => item.content || [])
      ?.map((part) => part.text || part.output_text || '')
      ?.join('\n') ||
    '';

  return extractJsonObject(text);
}

async function askGemini(config, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');

  const model = config.ai.geminiModel;
  const data = await fetchJsonWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    },
    config.ai.timeoutMs
  );

  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
  return extractJsonObject(text);
}

async function askOllama(config, prompt) {
  const baseUrl = (config.ai.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const data = await fetchJsonWithTimeout(
    `${baseUrl}/api/chat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.ai.ollamaModel || 'qwen2.5:3b',
        stream: false,
        options: {
          temperature: 0
        },
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    },
    config.ai.timeoutMs
  );

  return extractJsonObject(data.message?.content || data.response || '');
}

async function askAiSuggestion(config, questionData) {
  const provider = config.ai.provider.toLowerCase();
  const prompt = buildAiPrompt(questionData);
  return withRetries('AI suggestion', config.ai.retries, () => {
    if (provider === 'openai') return askOpenAi(config, prompt);
    if (provider === 'gemini') return askGemini(config, prompt);
    if (provider === 'ollama') return askOllama(config, prompt);
    throw new Error(`Unsupported AI provider: ${provider}`);
  });
}

async function saveDebug(page) {
  await mkdir(DEBUG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(DEBUG_DIR, `${stamp}.png`);
  const htmlPath = path.join(DEBUG_DIR, `${stamp}.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(htmlPath, await page.content(), 'utf8');
  return { screenshotPath, htmlPath };
}

async function visibleText(page, selector) {
  return page
    .locator(selector)
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.innerText || node.textContent || '')
        .map((text) => text.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    )
    .catch(() => []);
}

async function pageTitle(page) {
  const selectors = ['h1', 'h2', '.page-title', '.mat-card-title', '[class*="title"]'];
  for (const selector of selectors) {
    const text = normalizeText(await page.locator(selector).first().textContent({ timeout: 600 }).catch(() => ''));
    if (text && !/interactive|presentation|testing/i.test(text)) return text;
  }
  return '';
}

async function assertLoggedIn(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(500);

  const status = await page.evaluate(({ disciplines, progressStats }) => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const body = clean(document.body?.innerText || '');
    const hasPassword = !!document.querySelector('input[type="password"]');
    const hasLoginInput = !!document.querySelector('input[name*="login" i], input[name*="email" i], input[name*="user" i]');
    const hasStudentUrl = location.href.includes('/eAristoStudent/');
    const hasCabinet =
      (body.includes(disciplines) || body.includes(progressStats) || /HOLINCHENKO|ePLATO/i.test(body)) &&
      (body.includes(disciplines) || body.includes(progressStats));
    return { hasPassword, hasLoginInput, hasCabinet: hasCabinet || hasStudentUrl };
  }, { disciplines: UI.disciplines, progressStats: UI.progressStats });

  if (status.hasPassword || status.hasLoginInput || !status.hasCabinet) {
    throw new Error('Not logged in. Log in once in the opened browser profile, close it, then run npm start again.');
  }
}

async function collectPageSnapshot(page) {
  const title = await pageTitle(page);
  const rows = await Promise.race([
    visibleText(page, 'tr, .mat-row, .list-group-item, li, label, button, a, [class*="question"], [class*="answer"]'),
    new Promise((resolve) => setTimeout(() => resolve([]), 900))
  ]);
  return {
    url: page.url(),
    title,
    capturedAt: new Date().toISOString(),
    visibleItems: [...new Set(rows)].slice(0, 400)
  };
}

async function clickEnabledButtonByNames(page, names) {
  for (const name of names) {
    const button = page.getByRole('button', { name: new RegExp(escapeRegExp(name), 'i') }).first();
    if (await button.count()) {
      if (!(await button.isEnabled().catch(() => false))) continue;
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click();
      return true;
    }
  }
  return false;
}

async function clickByText(page, text) {
  const exact = page.getByText(new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`, 'i')).first();
  if (await exact.count()) {
    await exact.click();
    return true;
  }

  const partial = page.getByText(new RegExp(escapeRegExp(text), 'i')).first();
  if (await partial.count()) {
    await partial.click();
    return true;
  }

  return false;
}

async function clickRowActionByNumber(page, number) {
  return page.evaluate((number) => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const rowSelector = 'tr, li, .v-list-item, .mat-row, [role="row"], [class*="row"]';
    const rows = [...document.querySelectorAll(rowSelector)].filter(visible);
    const row = rows.find((node) => new RegExp(`^\\s*${number}\\s*[\\).:-]?\\s+`).test(clean(node.innerText || node.textContent)));
    if (!row) return false;

    const clickables = [
      ...row.querySelectorAll('button:not([disabled]), a[href], [role="button"], .v-icon, .material-icons, [class*="arrow"], [class*="play"]')
    ]
      .filter(visible)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const target = clickables.at(-1) || row;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, number).catch(() => false);
}

async function readVisibleNumberedRows(page) {
  return page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const rowSelector = 'tr, li, .v-list-item, .mat-row, [role="row"], [class*="row"]';
    const seen = new Set();
    return [...document.querySelectorAll(rowSelector)]
      .filter(visible)
      .map((node) => clean(node.innerText || node.textContent))
      .map((text) => {
        const match = text.match(/^\s*(\d{1,3})\s*[\).:-]?\s+(.+)/);
        return match ? { number: Number(match[1]), text } : null;
      })
      .filter((item) => {
        if (!item || seen.has(item.number)) return false;
        seen.add(item.number);
        return true;
      });
  }).catch(() => []);
}

async function clickAccordion(page, title) {
  return page.evaluate((title) => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll('button, .v-expansion-panel-header, .mat-expansion-panel-header, [role="button"], div')]
      .filter(visible)
      .map((node) => ({ node, text: clean(node.innerText || node.textContent) }))
      .filter((item) => item.text && item.text.length < 140 && item.text.toLowerCase().includes(title.toLowerCase()))
      .sort((a, b) => {
        const ar = a.node.getBoundingClientRect();
        const br = b.node.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      });
    const target = candidates[0]?.node;
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, title).catch(() => false);
}

async function isPanelExpanded(page, title) {
  return page.evaluate((title) => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll('.v-expansion-panel, .mat-expansion-panel, [class*="accordion"], [class*="panel"]')]
      .filter(visible)
      .filter((panel) => clean(panel.innerText || panel.textContent).toLowerCase().includes(title.toLowerCase()));

    return candidates.some((panel) =>
      panel.classList.contains('v-expansion-panel--active') ||
      panel.classList.contains('mat-expanded') ||
      panel.getAttribute('aria-expanded') === 'true' ||
      !!panel.querySelector('[aria-expanded="true"]')
    );
  }, title).catch(() => false);
}

async function expandAccordion(page, title, config) {
  if (await isPanelExpanded(page, title)) return true;
  const clicked = await clickAccordion(page, title);
  if (clicked) await waitAfterClick(page, config);
  return clicked;
}

async function isTestCompleted(page) {
  return page.evaluate(() => {
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return /Тест\s*пройдено|Результат|Ваш\s*бал|Зараховано|Completed|Result|Score/i.test(body);
  }).catch(() => false);
}

async function clickStartTest(page) {
  return clickEnabledButtonByNames(page, [UI.startTesting, UI.beginTesting, UI.start, UI.begin, 'Start']);
}

async function goToSubject(page, config, subjectNumber) {
  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });
  await waitAfterClick(page, config);
  const clicked = await retryAction(`open subject ${subjectNumber}`, () => clickRowActionByNumber(page, subjectNumber));
  if (clicked) await waitAfterClick(page, config);
  return clicked;
}

async function openNumberedRow(page, number, config) {
  const clicked = await retryAction(`open numbered row ${number}`, () => clickRowActionByNumber(page, number));
  if (clicked) await waitAfterClick(page, config);
  return clicked;
}

async function advancePresentation(page, config) {
  await expandAccordion(page, UI.interactivePresentation, config).catch(() => false);

  let clicks = 0;
  const donePatterns = [
    new RegExp(escapeRegExp(UI.presentationDone), 'i'),
    new RegExp(escapeRegExp(UI.lastSlide), 'i'),
    /completed viewing/i
  ];

  for (let index = 0; index < config.presentationMaxSlides; index += 1) {
    const body = normalizeText(await page.locator('body').textContent({ timeout: 1000 }).catch(() => ''));
    if (donePatterns.some((pattern) => pattern.test(body))) return clicks;

    const clicked = await clickEnabledButtonByNames(page, [UI.next, UI.nextNeuter, 'Next']);
    if (!clicked) return clicks;

    clicks += 1;
    await waitAfterClick(page, config);
  }

  return clicks;
}

async function scrollToTesting(page, config) {
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await sleep(config.timeouts.afterClickMs);
  await expandAccordion(page, UI.topicTest, config).catch(() => false);
}

async function extractQuestionFromDom(page) {
  return page.evaluate((ui) => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const nodes = [...document.querySelectorAll('body *')].filter(visible);
    const texts = nodes
      .map((node) => ({ node, text: clean(node.innerText || node.textContent) }))
      .filter((item) => item.text);

    const instruction = texts.find((item) =>
      item.text.toLowerCase().includes(ui.please) ||
      item.text.toLowerCase().includes(ui.choose) ||
      item.text.toLowerCase().includes(ui.sendAnswerLower) ||
      item.text.toLowerCase().includes(ui.correctPrefix)
    );

    let question = '';
    if (instruction) {
      let cursor = instruction.node;
      for (let depth = 0; cursor && depth < 5; depth += 1) {
        const candidates = [...cursor.querySelectorAll('*')]
          .map((node) => clean(node.innerText || node.textContent))
          .filter((text) => text.length > 40 && !/^\d+\s*[\).:-]/.test(text));
        question =
          candidates.find((text) => !text.toLowerCase().includes(ui.please) && !text.toLowerCase().includes(ui.sendAnswerLower)) || '';
        if (question) break;
        cursor = cursor.parentElement;
      }
    }

    if (!question) {
      question =
        texts
          .map((item) => item.text)
          .find((text) => text.length > 60 && !text.includes(ui.interactivePresentation) && !text.includes(ui.next)) || '';
    }

    const options = [];
    for (const { node, text } of texts) {
      const match = text.match(/^\s*(\d{1,2})\s*[\).:-]?\s+(.{3,})$/);
      if (!match) continue;
      const optionText = clean(match[2]);
      if (optionText.length > 180) continue;
      if (options.some((item) => item.text === optionText)) continue;
      options.push({ text: optionText, selector: node.tagName.toLowerCase(), index: 0, textOnly: true });
    }

    return { question, options };
  }, {
    please: UI.please,
    choose: UI.choose,
    correctPrefix: UI.correctPrefix,
    sendAnswerLower: UI.sendAnswerLower,
    interactivePresentation: UI.interactivePresentation,
    next: UI.next
  });
}

async function extractQuestion(page) {
  let question = '';
  const options = [];

  for (const selector of ['.question', '.test-question', '[class*="question"]', '[class*="task"]']) {
    question = normalizeText(await page.locator(selector).first().textContent({ timeout: 500 }).catch(() => ''));
    if (question.length > 10) break;
  }

  for (const selector of ['mat-radio-button', 'mat-checkbox', 'label', '[role="radio"]', '[role="checkbox"]']) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (!count) continue;
    for (let index = 0; index < count; index += 1) {
      const raw = normalizeText(await page.locator(selector).nth(index).textContent({ timeout: 500 }).catch(() => ''));
      const text = stripOptionNumber(raw);
      if (text && !options.some((item) => item.text === text)) options.push({ text, selector, index });
    }
    if (options.length) break;
  }

  const fromDom = await extractQuestionFromDom(page).catch(() => ({ question: '', options: [] }));
  if (!question) question = normalizeText(fromDom.question);

  for (const option of fromDom.options) {
    const text = stripOptionNumber(option.text);
    if (text && !options.some((item) => item.text === text)) options.push({ ...option, text });
  }

  return { question, options };
}

async function selectTextOption(page, text) {
  const escaped = escapeRegExp(text);
  const numbered = page.getByText(new RegExp(`^\\s*\\d+\\s*[\\).:-]?\\s*${escaped}\\s*$`, 'i')).first();
  if (await numbered.count()) {
    await numbered.click();
    return true;
  }

  const exact = page.getByText(new RegExp(`^\\s*${escaped}\\s*$`, 'i')).first();
  if (await exact.count()) {
    await exact.click();
    return true;
  }

  return false;
}

async function selectOptionByNumber(page, options, number) {
  const option = options[number - 1];
  if (!option) return false;
  if (option.textOnly) return selectTextOption(page, option.text);
  await page.locator(option.selector).nth(option.index).click();
  return true;
}

async function submitOrNext(page) {
  return clickEnabledButtonByNames(page, [UI.submitAnswer, UI.submit, 'Submit', UI.further, UI.nextNeuter, UI.next, 'Next', UI.save]);
}

async function readAndStoreQuestion(page, observed, topic) {
  const current = await extractQuestion(page);
  lastQuestion = current;
  observed.push({
    url: page.url(),
    title: topic,
    capturedAt: new Date().toISOString(),
    question: current.question,
    options: current.options.map((item) => item.text)
  });
  await writeJson(OBSERVED_PATH, observed);
  console.log(`\nQuestion: ${current.question || '(not detected)'}`);
  current.options.forEach((option, index) => console.log(`${index + 1}. ${option.text}`));
  return current;
}

async function askConfirmAndApplySuggestion(page, config, questionData, submitAfterConfirm = false) {
  const suggestion = await askAiSuggestion(config, questionData);
  console.log(`\nAI answer numbers: ${(suggestion.answerNumbers || []).join(', ') || '(none)'}`);
  console.log(`AI answer texts: ${(suggestion.answerTexts || []).join('; ') || '(none)'}`);
  console.log(`Confidence: ${suggestion.confidence ?? 'unknown'}`);
  console.log(`Reason: ${suggestion.explanation || '(no explanation)'}`);

  const apply = (await rl.question('Apply this suggestion? y/N/manual number: ')).trim().toLowerCase();
  let numbers = [];
  if (apply === 'y' || apply === 'yes') numbers = suggestion.answerNumbers || [];
  else {
    const manualNumber = Number.parseInt(apply, 10);
    if (Number.isInteger(manualNumber)) numbers = [manualNumber];
  }
  if (!numbers.length) return false;

  let selectedAny = false;
  for (const number of numbers) selectedAny ||= await selectOptionByNumber(page, questionData.options, Number(number));
  if (!selectedAny) {
    console.log('Could not select suggested option.');
    return false;
  }
  console.log('Answer selected.');
  if (submitAfterConfirm) console.log((await submitOrNext(page)) ? 'Submitted.' : 'Selected, but submit button was not enabled/found.');
  return true;
}

async function runGuidedBatch(page, config, observed) {
  const subjectInput = await rl.question('Subject number from the main list (example: 1): ');
  const moduleInput = await rl.question('Module numbers in the left module list (example: 2 4 5, or all): ');
  const topicInput = await rl.question('Topic numbers in the right topic list (example: 1 2 3, or all): ');
  const subjectNumber = Number.parseInt(subjectInput, 10);
  const moduleNumbers = parseNumberList(moduleInput);
  const requestedTopicNumbers = parseNumberList(topicInput);

  if (!Number.isInteger(subjectNumber) || subjectNumber <= 0) return console.log('Subject number is invalid.');
  if ((Array.isArray(moduleNumbers) && !moduleNumbers.length) || (Array.isArray(requestedTopicNumbers) && !requestedTopicNumbers.length)) {
    return console.log('Module/topic numbers are empty.');
  }

  console.log(`Opening subject number: ${subjectNumber}`);
  if (!(await goToSubject(page, config, subjectNumber))) {
    console.log('Could not open subject automatically. Open it manually, then press Enter.');
    await rl.question('Ready? ');
  }

  const subjectUrl = page.url();
  const modulesToRun = moduleNumbers === 'all' ? (await readVisibleNumberedRows(page)).map((row) => row.number) : moduleNumbers;
  for (const moduleNumber of modulesToRun) {
    console.log(`\n=== Module ${moduleNumber} ===`);

    if (page.url() !== subjectUrl) {
      await page.goto(subjectUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitAfterClick(page, config);
    }

    if (!(await openNumberedRow(page, moduleNumber, config))) {
      console.log(`Could not open module ${moduleNumber}. Open it manually, then press Enter.`);
      await rl.question('Ready? ');
    }

    const moduleUrl = page.url();
    const topicsToRun = requestedTopicNumbers === 'all' ? (await readVisibleNumberedRows(page)).map((row) => row.number) : requestedTopicNumbers;
    for (const topicNumber of topicsToRun) {
      console.log(`\n--- Topic ${topicNumber} ---`);

      if (page.url() !== moduleUrl) {
        await page.goto(moduleUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await waitAfterClick(page, config);
      }

      if (!(await openNumberedRow(page, topicNumber, config))) {
        console.log(`Could not open topic ${topicNumber}. Open it manually, then press Enter.`);
        await rl.question('Ready? ');
      }

      await clickStartTest(page).catch(() => false);
      await waitAfterClick(page, config);
      console.log(`Presentation advanced: ${await advancePresentation(page, config)} click(s).`);

      await scrollToTesting(page, config);
      if (await isTestCompleted(page)) {
        console.log('Test already completed/result visible. Skipping this topic.');
        continue;
      }

      const topicTitle = (await pageTitle(page)) || `subject ${subjectNumber} module ${moduleNumber} topic ${topicNumber}`;
      const current = await readAndStoreQuestion(page, observed, topicTitle);
      if (!current.question || !current.options.length) {
        const saved = await saveDebug(page);
        console.log(`Question/options not detected. Debug saved: ${saved.screenshotPath}`);
        continue;
      }

      try {
        await askConfirmAndApplySuggestion(page, config, current, true);
      } catch (error) {
        console.log(`AI suggestion failed: ${error.message}`);
      }

      await waitAfterClick(page, config);
      await page.goto(moduleUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitAfterClick(page, config);
    }
  }
}

function mergeConfig(config) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    ai: { ...DEFAULT_CONFIG.ai, ...(config.ai || {}) },
    timeouts: { ...DEFAULT_CONFIG.timeouts, ...(config.timeouts || {}) }
  };
}

async function run() {
  const config = mergeConfig(await readJson(CONFIG_PATH, {}));
  const observed = await readJson(OBSERVED_PATH, []);
  const profileDir = path.resolve(ROOT, config.profileDir);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: config.headless,
    slowMo: config.slowMoMs
  });

  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(config.timeouts.pageMs);
  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });
  await assertLoggedIn(page);
  console.log('\nLogged in. Ready.');

  while (true) {
    console.log(`\nCurrent URL: ${page.url()}`);
    console.log('1 - save visible page items');
    console.log('2 - click start testing');
    console.log('3 - read current question');
    console.log('4 - click element by text');
    console.log('5 - submit / next');
    console.log('6 - save debug screenshot/html');
    console.log('7 - select last option by number');
    console.log('8 - ask AI suggestion');
    console.log('9 - guided batch mode');
    console.log('0 - exit');

    const choice = (await rl.question('Choose action: ')).trim();
    if (choice === '0') break;
    if (choice === '1') {
      const snapshot = await collectPageSnapshot(page);
      observed.push(snapshot);
      await writeJson(OBSERVED_PATH, observed);
      console.log(`Saved to ${OBSERVED_PATH}`);
    } else if (choice === '2') {
      console.log((await clickStartTest(page)) ? 'Clicked start button.' : 'Start button not found.');
    } else if (choice === '3') {
      const snapshot = await collectPageSnapshot(page);
      await readAndStoreQuestion(page, observed, snapshot.title || '*');
    } else if (choice === '4') {
      console.log((await clickByText(page, (await rl.question('Element text: ')).trim())) ? 'Clicked.' : 'Element not found.');
    } else if (choice === '5') {
      console.log((await submitOrNext(page)) ? 'Clicked submit/next.' : 'Enabled submit/next button not found.');
    } else if (choice === '6') {
      const saved = await saveDebug(page);
      console.log(`Saved screenshot: ${saved.screenshotPath}`);
      console.log(`Saved html: ${saved.htmlPath}`);
    } else if (choice === '7') {
      if (!lastQuestion?.options?.length) console.log('No saved options yet. Use action 3 first.');
      else {
        const number = Number.parseInt(await rl.question(`Option number 1-${lastQuestion.options.length}: `), 10);
        console.log((await selectOptionByNumber(page, lastQuestion.options, number)) ? `Selected option ${number}.` : 'Could not select that option.');
      }
    } else if (choice === '8') {
      if (!lastQuestion?.question || !lastQuestion?.options?.length) console.log('No saved question/options yet. Use action 3 first.');
      else if (await askConfirmAndApplySuggestion(page, config, lastQuestion, false)) console.log('Use action 5 to submit.');
    } else if (choice === '9') {
      await runGuidedBatch(page, config, observed);
    }
    await waitAfterClick(page, config);
  }

  await context.close();
  rl.close();
}

run().catch((error) => {
  console.error(error);
  rl.close();
  process.exitCode = 1;
});
