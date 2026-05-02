# ePlato helper

Small Playwright helper for repetitive ePlato flows.

It opens the site in a real browser, lets you log in manually, saves visible questions/options to `data/observed-questions.json`, and can select answers only from your local `answers.json`.

The script now checks login automatically on startup. If the saved browser profile is not logged in, it exits with an error instead of waiting for Enter.

## Run

```powershell
npm.cmd start
```

Use `npm.cmd` on Windows if PowerShell blocks `npm`.

The active entrypoint is `src/main.js`. The older file is still available through:

```powershell
npm.cmd run start:legacy
```

Quick syntax check:

```powershell
npm.cmd run check
```

First-time login:

1. Run the script once.
2. If it exits with `Not logged in`, open the Playwright browser window, log in to ePlato, close it, and run again.
3. The login session is stored in `.browser-profile`.

## Config

In `config.json`:

```json
{
  "mode": "manual",
  "autoSubmit": false,
  "ai": {
    "provider": "gemini",
    "openaiApi": "responses",
    "openaiModel": "gpt-5-mini",
    "geminiModel": "gemini-2.5-flash",
    "retries": 2,
    "timeoutMs": 45000
  }
}
```

- `manual` only reads/saves page data.
- `answer-bank` tries to select an answer if it exists in `answers.json`.
- `autoSubmit: false` leaves submit/next clicks manual.
- `autoSubmit: true` clicks submit/next after a matched answer.
- `ai.provider` can be `gemini` or `openai`.
- `ai.openaiApi` can be `responses` or `chat`.
- `ai.retries` retries transient AI/API failures.
- `ai.timeoutMs` limits one AI request.
- `presentationMaxSlides` limits how many times guided mode can click `Next`.

## Current stability notes

- `npm start` uses `src/main.js`, which avoids Windows encoding issues by storing Ukrainian UI strings as Unicode escapes.
- The script checks login automatically and exits if the saved browser profile is not logged in.
- Fixed timeouts are kept short; most waits now continue as soon as the page is ready.
- If navigation fails on a specific page, use menu action `6` and send the files from `data/debug`.

## AI suggestion

Set one API key before running:

```powershell
$env:GEMINI_API_KEY="your_key_here"
npm.cmd start
```

or:

```powershell
$env:OPENAI_API_KEY="your_key_here"
npm.cmd start
```

For `cmd`:

```cmd
set OPENAI_API_KEY=your_key_here
npm start
```

Do not put real API keys into `config.json`.

Flow:

1. Open the question page.
2. Use action `3` to read the current question.
3. Use action `8` to ask AI for a suggested answer.
4. Confirm with `y` if you want the script to select that option.
5. Use action `5` to submit/next.

## Guided batch mode

Use menu action `9` when you want the helper to process several topics/modules.

Example:

```text
9
Subject number: 5
Module numbers: 2 4 5
Topic numbers: all
```

What it does:

1. Opens the subject by number from the main subject list.
2. Opens modules by number from the left module list. You can type `all`.
3. Opens topics by number from the right topic list by clicking the blue arrow. You can type `all`.
4. Expands the interactive presentation panel.
5. Clicks through the presentation with the next-slide button.
6. Expands the topic test panel.
7. Reads the question and answer options.
8. Asks AI for a suggestion.
9. Waits for your confirmation.
10. Selects and submits only after confirmation.

At the confirmation prompt:

```text
Apply this suggestion? y/N/manual number:
```

- Type `y` to accept the AI suggestion.
- Type a number like `3` to choose an option manually.
- Press Enter to skip.

## answers.json

Global answers:

```json
{
  "*": {
    "part of the question text": [
      "part of the correct option text"
    ]
  }
}
```

Per-topic answers:

```json
{
  "Topic title from the page": {
    "part of the question text": [
      "part of the correct option text"
    ]
  }
}
```

If there is no match, the script leaves selection to you.
