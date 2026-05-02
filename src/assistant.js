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

const DEFAULT_CONFIG = {
  startUrl: 'https://ez.pdmu.edu.ua/eAristoStudent/subjects',
  profileDir: '.browser-profile',
  headless: false,
  mode: 'manual',
  autoSubmit: false,
  ai: {
    provider: 'gemini',
    openaiModel: 'gpt-5-mini',
    geminiModel: 'gemini-2.5-flash'
  },
  presentationMaxSlides: 250,
  slowMoMs: 0,
  timeouts: {
    pageMs: 30000,
    afterClickMs: 350
  }
};

const rl = createInterface({ input, output });
let lastQuestion = null;

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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

function normalizeText(value) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function stripOptionNumber(value) {
  return normalizeText(value).replace(/^\d+\s*[\).:-]?\s*/, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNumberList(input) {
  const value = normalizeText(input).toLowerCase();
  if (value === 'all') return 'all';

  const numbers = value
    .split(/[\s,;]+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((number) => Number.isInteger(number) && number > 0);

  return [...new Set(numbers)];
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
  const options = questionData.options
    .map((option, index) => `${index + 1}. ${option.text}`)
    .join('\n');

  return `You are helping with a non-graded webinar registration quiz. Choose the most likely correct option from the given choices.

Return only valid JSON in this shape:
{
  "answerNumbers": [1],
  "answerTexts": ["exact option text"],
  "confidence": 0.0,
  "explanation": "short reason"
}

Question:
${questionData.question}

Options:
${options}`;
}

async function askOpenAi(config, prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.ai?.openaiModel || 'gpt-5-mini',
      input: prompt
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI error: ${JSON.stringify(data)}`);
  }

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

  const model = config.ai?.geminiModel || 'gemini-2.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json'
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini error: ${JSON.stringify(data)}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
  return extractJsonObject(text);
}

async function askAiSuggestion(config, questionData) {
  const provider = (config.ai?.provider || 'gemini').toLowerCase();
  const prompt = buildAiPrompt(questionData);

  if (provider === 'openai') return askOpenAi(config, prompt);
  if (provider === 'gemini') return askGemini(config, prompt);

  throw new Error(`Unsupported AI provider: ${provider}`);
}

async function waitForUser(message) {
  await rl.question(`${message}\nPress Enter when ready... `);
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
    const text = normalizeText(await page.locator(selector).first().textContent({ timeout: 750 }).catch(() => ''));
    if (text && !/interactive|presentation|testing/i.test(text)) return text;
  }
  return '';
}

async function assertLoggedIn(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(800);

  const status = await page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const body = clean(document.body?.innerText || '');
    const hasPassword = !!document.querySelector('input[type="password"]');
    const hasLoginInput = !!document.querySelector('input[name*="login" i], input[name*="email" i], input[name*="user" i]');
    const hasCabinet =
      /Дисципліни|Статистика проходження|HOLINCHENKO|ePLATO/i.test(body) &&
      /Дисципліни|Статистика проходження/i.test(body);

    return {
      body,
      hasPassword,
      hasLoginInput,
      hasCabinet
    };
  });

  if (status.hasPassword || status.hasLoginInput || !status.hasCabinet) {
    throw new Error('Not logged in. Open the Playwright browser profile once, log in to ePlato, then run the script again.');
  }
}

async function collectPageSnapshot(page) {
  const title = await pageTitle(page);
  const rows = await Promise.race([
    visibleText(page, 'tr, .mat-row, .list-group-item, li, label, button, a, [class*="question"], [class*="answer"]'),
    new Promise((resolve) => setTimeout(() => resolve([]), 1200))
  ]);
  return {
    url: page.url(),
    title,
    capturedAt: new Date().toISOString(),
    visibleItems: [...new Set(rows)].slice(0, 400)
  };
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

async function clickContainerByPattern(page, pattern, flags = 'i') {
  return page.evaluate(
    ({ pattern, flags }) => {
      const regex = new RegExp(pattern, flags);
      const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const visible = (node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const candidates = [...document.querySelectorAll('button, a, tr, li, .v-list-item, .mat-row, [role="row"], [class*="row"]')]
        .filter(visible)
        .map((node) => ({ node, text: clean(node.innerText || node.textContent) }))
        .filter((item) => item.text && item.text.length < 800 && regex.test(item.text));

      candidates.sort((a, b) => {
        const ar = a.node.getBoundingClientRect();
        const br = b.node.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      });

      const target = candidates[0]?.node;
      if (!target) return false;

      const clickable = [...target.querySelectorAll('button:not([disabled]), a[href], [role="button"]')]
        .filter(visible)
        .at(-1);

      (clickable || target).scrollIntoView({ block: 'center', inline: 'center' });
      (clickable || target).click();
      return true;
    },
    { pattern, flags }
  );
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
    const row = rows.find((node) => {
      const text = clean(node.innerText || node.textContent);
      return new RegExp(`^\\s*${number}\\s*[\\).:-]?\\s+`).test(text);
    });
    if (!row) return false;

    const clickableSelectors = [
      'button:not([disabled])',
      'a[href]',
      '[role="button"]',
      '.v-icon',
      '.material-icons',
      '[class*="arrow"]',
      '[class*="play"]'
    ];
    const clickables = clickableSelectors
      .flatMap((selector) => [...row.querySelectorAll(selector)])
      .filter(visible)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const target = clickables.at(-1) || row;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, number);
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
    return [...document.querySelectorAll(rowSelector)]
      .filter(visible)
      .map((node) => clean(node.innerText || node.textContent))
      .map((text) => {
        const match = text.match(/^\s*(\d{1,3})\s*[\).:-]?\s+(.+)/);
        return match ? { number: Number(match[1]), text } : null;
      })
      .filter(Boolean);
  });
}

async function clickAccordion(page, title) {
  return page.evaluate((title) => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const regex = new RegExp(title, 'i');
    const candidates = [...document.querySelectorAll('button, .v-expansion-panel-header, .mat-expansion-panel-header, [role="button"], div')]
      .filter(visible)
      .map((node) => ({ node, text: clean(node.innerText || node.textContent) }))
      .filter((item) => item.text && item.text.length < 120 && regex.test(item.text))
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
  }, title);
}

async function clickStartTest(page) {
  const candidates = [
    'Розпочати тестування',
    'Почати тестування',
    'Розпочати',
    'Почати',
    'Start'
  ];

  for (const text of candidates) {
    const button = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
    if (await button.count()) {
      await button.click();
      return true;
    }
  }

  return false;
}

async function clickEnabledButtonByNames(page, names) {
  for (const name of names) {
    const button = page.getByRole('button', { name: new RegExp(name, 'i') }).first();
    if (await button.count()) {
      if (!(await button.isEnabled().catch(() => false))) continue;
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click();
      return true;
    }
  }
  return false;
}

async function goToSubject(page, config, subjectNumber) {
  await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(config.timeouts.afterClickMs);

  const clicked = await clickRowActionByNumber(page, subjectNumber);
  if (!clicked) return false;

  await page.waitForTimeout(config.timeouts.afterClickMs);
  return true;
}

async function openTopicByNumber(page, number, config) {
  const clicked = await clickRowActionByNumber(page, number);
  if (clicked) {
    await page.waitForTimeout(config.timeouts.afterClickMs);
    return true;
  }

  return false;
}

async function advancePresentation(page, config) {
  await clickAccordion(page, 'Інтерактивна презентація').catch(() => false);
  await page.waitForTimeout(config.timeouts.afterClickMs);

  let clicks = 0;
  const donePatterns = [
    /Ви завершили перегляд презентації/i,
    /останній слайд/i,
    /completed viewing/i
  ];

  for (let index = 0; index < config.presentationMaxSlides; index += 1) {
    const body = normalizeText(await page.locator('body').textContent().catch(() => ''));
    if (donePatterns.some((pattern) => pattern.test(body))) return clicks;

    const clicked = await clickEnabledButtonByNames(page, ['Наступний', 'Next']);
    if (!clicked) return clicks;

    clicks += 1;
    await page.waitForTimeout(config.timeouts.afterClickMs);
  }

  return clicks;
}

async function scrollToTesting(page) {
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await clickAccordion(page, 'Тестування по темі').catch(() => false);
  await page.waitForTimeout(500);
}

async function extractQuestionFromDom(page) {
  return page.evaluate(() => {
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
      /будь ласка|виберіть|відправити відповідь|правильн/i.test(item.text)
    );

    let question = '';
    if (instruction) {
      let cursor = instruction.node;
      for (let depth = 0; cursor && depth < 5; depth += 1) {
        const candidates = [...cursor.querySelectorAll('*')]
          .map((node) => clean(node.innerText || node.textContent))
          .filter((text) => text.length > 40 && !/^\d+\s*[\).:-]/.test(text));
        question = candidates.find((text) => !/будь ласка|відправити відповідь/i.test(text)) || '';
        if (question) break;
        cursor = cursor.parentElement;
      }
    }

    if (!question) {
      const longTexts = texts
        .map((item) => item.text)
        .filter((text) => text.length > 60 && !/інтерактивна презентація|попередній|наступний/i.test(text));
      question = longTexts[0] || '';
    }

    const options = [];
    const optionRegex = /^\s*(\d{1,2})\s*[\).:-]?\s+(.{3,})$/;
    for (const { node, text } of texts) {
      const match = text.match(optionRegex);
      if (!match) continue;
      const optionText = clean(match[2]);
      if (optionText.length > 120) continue;
      if (options.some((item) => item.text === optionText)) continue;

      const selector = node.tagName.toLowerCase();
      options.push({ text: optionText, selector, index: 0 });
    }

    return { question, options };
  });
}

async function extractQuestion(page) {
  const fromDom = await extractQuestionFromDom(page).catch(() => ({ question: '', options: [] }));
  let question = normalizeText(fromDom.question);
  const options = [];

  const optionLocators = [
    'mat-radio-button',
    'mat-checkbox',
    'label',
    '[role="radio"]',
    '[role="checkbox"]',
    'input[type="radio"]',
    'input[type="checkbox"]'
  ];

  for (const selector of optionLocators) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (!count) continue;

    for (let index = 0; index < count; index += 1) {
      const locator = page.locator(selector).nth(index);
      const raw = normalizeText(await locator.textContent().catch(() => ''));
      const text = stripOptionNumber(raw);
      if (text && !options.some((item) => item.text === text)) {
        options.push({ text, selector, index });
      }
    }

    if (options.length) break;
  }

  for (const option of fromDom.options) {
    const text = stripOptionNumber(option.text);
    if (text && !options.some((item) => item.text === text)) {
      options.push({ text, selector: option.selector, index: option.index, textOnly: true });
    }
  }

  if (!question) {
    const questionSelectors = ['.question', '.test-question', '[class*="question"]', '[class*="task"]'];
    for (const selector of questionSelectors) {
      question = normalizeText(await page.locator(selector).first().textContent().catch(() => ''));
      if (question.length > 10) break;
    }
  }

  return { question, options };
}

function findKnownAnswers(answers, topic, question) {
  const topicAnswers = answers[topic] ?? answers['*'] ?? {};
  const exact = topicAnswers[question];
  if (exact) return Array.isArray(exact) ? exact : [exact];

  const normalizedQuestion = normalizeText(question).toLowerCase();
  for (const [key, value] of Object.entries(topicAnswers)) {
    const normalizedKey = normalizeText(key).toLowerCase();
    if (normalizedQuestion.includes(normalizedKey) || normalizedKey.includes(normalizedQuestion)) {
      return Array.isArray(value) ? value : [value];
    }
  }

  return [];
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

async function selectAnswers(page, options, knownAnswers) {
  const matched = [];
  for (const answer of knownAnswers) {
    const normalizedAnswer = normalizeText(answer).toLowerCase();
    const option = options.find((item) => normalizeText(item.text).toLowerCase().includes(normalizedAnswer));
    if (!option) continue;

    if (option.textOnly) {
      if (await selectTextOption(page, option.text)) matched.push(option.text);
      continue;
    }

    await page.locator(option.selector).nth(option.index).click();
    matched.push(option.text);
  }
  return matched;
}

async function selectOptionByNumber(page, options, number) {
  const option = options[number - 1];
  if (!option) return false;

  if (option.textOnly) {
    return selectTextOption(page, option.text);
  }

  await page.locator(option.selector).nth(option.index).click();
  return true;
}

async function submitOrNext(page) {
  const candidates = [
    'Відправити відповідь',
    'Відправити',
    'Submit',
    'Далі',
    'Наступне',
    'Наступний',
    'Next',
    'Зберегти'
  ];
  for (const text of candidates) {
    const button = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
    if (await button.count()) {
      if (!(await button.isEnabled().catch(() => false))) continue;
      await button.click();
      return true;
    }
  }
  return false;
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
  if (apply === 'y' || apply === 'yes') {
    numbers = suggestion.answerNumbers || [];
  } else {
    const manualNumber = Number.parseInt(apply, 10);
    if (Number.isInteger(manualNumber)) numbers = [manualNumber];
  }

  if (!numbers.length) return false;

  let selectedAny = false;
  for (const number of numbers) {
    const selected = await selectOptionByNumber(page, questionData.options, Number(number));
    selectedAny ||= selected;
  }

  if (!selectedAny) {
    console.log('Could not select suggested option.');
    return false;
  }

  console.log('Answer selected.');
  if (submitAfterConfirm) {
    const submitted = await submitOrNext(page);
    console.log(submitted ? 'Submitted.' : 'Selected, but submit button was not enabled/found.');
  }

  return true;
}

async function runGuidedBatch(page, config, observed) {
  const subjectInput = await rl.question('Subject number from the main list (example: 1): ');
  const moduleInput = await rl.question('Module numbers in the left module list (example: 2 4 5, or all): ');
  const topicInput = await rl.question('Topic numbers in the right topic list (example: 1 2 3, or all): ');
  const subjectNumber = Number.parseInt(subjectInput, 10);
  const moduleNumbers = parseNumberList(moduleInput);
  const requestedTopicNumbers = parseNumberList(topicInput);

  if (!Number.isInteger(subjectNumber) || subjectNumber <= 0) {
    console.log('Subject number is invalid.');
    return;
  }

  if ((Array.isArray(moduleNumbers) && !moduleNumbers.length) || (Array.isArray(requestedTopicNumbers) && !requestedTopicNumbers.length)) {
    console.log('Module/topic numbers are empty.');
    return;
  }

  console.log(`Opening subject number: ${subjectNumber}`);
  const openedSubject = await goToSubject(page, config, subjectNumber);
  if (!openedSubject) {
    console.log('Could not open subject automatically. Open it manually in the browser, then press Enter.');
    await waitForUser('Ready to continue batch mode.');
  }

  const modulesToRun = moduleNumbers === 'all'
    ? (await readVisibleNumberedRows(page)).map((row) => row.number)
    : moduleNumbers;

  for (const moduleNumber of modulesToRun) {
    console.log(`\n=== Module ${moduleNumber} ===`);

    const openedModule = await openTopicByNumber(page, moduleNumber, config);
    if (!openedModule) {
      console.log(`Could not open module ${moduleNumber} automatically.`);
      await waitForUser(`Open module ${moduleNumber} manually, then continue.`);
    }

    const topicsToRun = requestedTopicNumbers === 'all'
      ? (await readVisibleNumberedRows(page)).map((row) => row.number)
      : requestedTopicNumbers;

    for (const topicNumber of topicsToRun) {
      console.log(`\n--- Topic ${topicNumber} ---`);

      const openedTopic = await openTopicByNumber(page, topicNumber, config);
      if (!openedTopic) {
        console.log(`Could not open topic ${topicNumber} automatically.`);
        await waitForUser(`Open topic ${topicNumber} manually, then continue.`);
      }

      await clickStartTest(page).catch(() => false);
      await page.waitForTimeout(config.timeouts.afterClickMs);

      const slideClicks = await advancePresentation(page, config);
      console.log(`Presentation advanced: ${slideClicks} click(s).`);

      await scrollToTesting(page);
      const topicTitle = (await pageTitle(page)) || `subject ${subjectNumber} module ${moduleNumber} topic ${topicNumber}`;
      const current = await readAndStoreQuestion(page, observed, topicTitle);

      if (!current.question || !current.options.length) {
        console.log('Question/options were not detected. Saving debug files.');
        const saved = await saveDebug(page);
        console.log(`Saved screenshot: ${saved.screenshotPath}`);
        console.log(`Saved html: ${saved.htmlPath}`);
        await waitForUser('Fix the page manually if needed, then continue.');
        continue;
      }

      try {
        await askConfirmAndApplySuggestion(page, config, current, true);
      } catch (error) {
        console.log(`AI suggestion failed: ${error.message}`);
        const manual = await rl.question(`Manual option number 1-${current.options.length}, or empty to skip: `);
        const number = Number.parseInt(manual, 10);
        if (Number.isInteger(number)) {
          const selected = await selectOptionByNumber(page, current.options, number);
          console.log(selected ? `Selected option ${number}.` : 'Could not select that option.');
          if (selected) {
            const submit = (await rl.question('Submit this answer? y/N: ')).trim().toLowerCase();
            if (submit === 'y' || submit === 'yes') await submitOrNext(page);
          }
        }
      }

      await page.waitForTimeout(config.timeouts.afterClickMs);
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(config.timeouts.afterClickMs);
    }

    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(config.timeouts.afterClickMs);
  }
}

async function run() {
  const config = { ...DEFAULT_CONFIG, ...(await readJson(CONFIG_PATH, {})) };
  const answers = await readJson(ANSWERS_PATH, {});
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
      continue;
    }

    if (choice === '2') {
      const clicked = await clickStartTest(page);
      console.log(clicked ? 'Clicked start button.' : 'Start button not found.');
      await page.waitForTimeout(config.timeouts.afterClickMs);
      continue;
    }

    if (choice === '3') {
      const snapshot = await collectPageSnapshot(page);
      const topic = snapshot.title || '*';
      const current = await readAndStoreQuestion(page, observed, topic);
      const knownAnswers = findKnownAnswers(answers, topic, current.question);

      if (knownAnswers.length) {
        console.log(`\nFound in answers.json: ${knownAnswers.join('; ')}`);
        if (config.mode === 'answer-bank') {
          const matched = await selectAnswers(page, current.options, knownAnswers);
          console.log(matched.length ? `Selected: ${matched.join('; ')}` : 'Could not match saved answer to visible options.');
          if (config.autoSubmit) await submitOrNext(page);
        }
      } else {
        console.log('\nNo matching answer in answers.json. Add one or select manually in the browser.');
      }
      continue;
    }

    if (choice === '4') {
      const text = await rl.question('Element text: ');
      const clicked = await clickByText(page, text.trim());
      console.log(clicked ? 'Clicked.' : 'Element not found.');
      await page.waitForTimeout(config.timeouts.afterClickMs);
      continue;
    }

    if (choice === '5') {
      const clicked = await submitOrNext(page);
      console.log(clicked ? 'Clicked submit/next.' : 'Enabled submit/next button not found. Select an option first.');
      await page.waitForTimeout(config.timeouts.afterClickMs);
      continue;
    }

    if (choice === '6') {
      const saved = await saveDebug(page);
      console.log(`Saved screenshot: ${saved.screenshotPath}`);
      console.log(`Saved html: ${saved.htmlPath}`);
      continue;
    }

    if (choice === '7') {
      if (!lastQuestion?.options?.length) {
        console.log('No saved options yet. Use action 3 first.');
        continue;
      }

      const answer = await rl.question(`Option number 1-${lastQuestion.options.length}: `);
      const number = Number.parseInt(answer, 10);
      const selected = await selectOptionByNumber(page, lastQuestion.options, number);
      console.log(selected ? `Selected option ${number}.` : 'Could not select that option.');
      await page.waitForTimeout(config.timeouts.afterClickMs);
      continue;
    }

    if (choice === '8') {
      if (!lastQuestion?.question || !lastQuestion?.options?.length) {
        console.log('No saved question/options yet. Use action 3 first.');
        continue;
      }

      try {
        const selected = await askConfirmAndApplySuggestion(page, config, lastQuestion, false);
        if (selected) console.log('Use action 5 to submit.');
      } catch (error) {
        console.log(`AI suggestion failed: ${error.message}`);
      }
      continue;
    }

    if (choice === '9') {
      await runGuidedBatch(page, config, observed);
    }
  }

  await context.close();
  rl.close();
}

run().catch(async (error) => {
  console.error(error);
  rl.close();
  process.exitCode = 1;
});
