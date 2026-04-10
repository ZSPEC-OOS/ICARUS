// ─── BLUSWAN Simple Mode ────────────────────────────────────────────────────────
//
// A plain-English translation layer for users with no coding experience.
// Nothing in BLUSWAN is removed — this module overlays human-friendly language
// on top of every technical string so non-coders can follow what's happening.
//
// Design rules
//   1. Never assume the user knows what Git, npm, eslint, CI, tokens, or
//      API keys are. Every term is replaced or explained in-line.
//   2. Actions are described by *what they accomplish*, not *how* they do it.
//   3. Errors are described by *what the user should do next*, not *what went wrong internally*.
//   4. All exports are pure values / pure functions — no React, no side-effects.
//
// Usage
//   import { t, translateActivity, translateError,
//            SIMPLE_LABELS, SIMPLE_EXAMPLES, SIMPLE_TIPS } from './bluswanSimpleMode'
//
//   // Translate a raw activity string
//   const msg = translateActivity('◈ Building file plan…')
//   // → "Planning which files to create or update…"
//
//   // Translate an error code
//   const err = translateError('api-401')
//   // → { headline: 'Access denied', body: 'Your AI key is wrong or expired…', action: 'Open Settings → AI Key' }
//
//   // Check if simple mode is enabled (respects localStorage flag)
//   import { isSimpleMode } from './bluswanSimpleMode'
//   if (isSimpleMode()) { /* show plain-English UI */ }
//
// ─────────────────────────────────────────────────────────────────────────────

import { KEYS } from '../shared/storageKeys.js'

// ── Simple Mode toggle ────────────────────────────────────────────────────────
// Stored in localStorage so it persists across reloads.
// DEFAULT IS ON — plain English is the out-of-the-box experience.
// Only users who explicitly switch to Expert Mode will see technical language.
const SIMPLE_MODE_KEY = KEYS.LS.SIMPLE_MODE

export function isSimpleMode() {
  try {
    const stored = localStorage.getItem(SIMPLE_MODE_KEY)
    // If no preference has ever been stored this is a new user — default to ON
    if (stored === null) return true
    return stored === 'true'
  } catch { return true }
}

// Explicitly called "Expert Mode" when turning simple mode off,
// so the Settings button reads "Switch to Expert Mode" (not "Disable Simple Mode").
export function enableSimpleMode()  {
  try { localStorage.setItem(SIMPLE_MODE_KEY, 'true')  } catch {}
}

export function enableExpertMode() {
  try { localStorage.setItem(SIMPLE_MODE_KEY, 'false') } catch {}
}

// Keep the old name as an alias so existing call sites don't break
export const disableSimpleMode = enableExpertMode

export function toggleSimpleMode() {
  isSimpleMode() ? enableExpertMode() : enableSimpleMode()
  return isSimpleMode()
}

// Human-readable label for the toggle button — changes based on current state
export function simpleModeToggleLabel() {
  return isSimpleMode() ? 'Switch to Expert Mode' : 'Switch to Simple Mode (recommended)'
}

// ── t() — conditional translator ─────────────────────────────────────────────
// Returns the plain-English version when simple mode is on, technical otherwise.
// Usage: t('Building file plan…', 'Planning which files to create…')
export function t(technical, plain) {
  return isSimpleMode() ? plain : technical
}

// ── Activity feed translations ────────────────────────────────────────────────
// Maps raw activity strings (or substrings) to plain-English equivalents.
// Keys are matched by substring so partial activity messages are covered.

const ACTIVITY_MAP = [
  // Intent amplification
  { match: 'Analyzing intent',            plain: 'Understanding what you asked for' },
  { match: 'Intent clarified',            plain: 'Got it — here is what I understood:' },
  { match: 'assumption',                  plain: 'decision I made for you' },

  // Planning
  { match: 'Building file plan',          plain: 'Planning which files to create or update' },
  { match: 'file plan',                   plain: 'file plan (list of files to create or change)' },
  { match: 'Planner returned no files',   plain: 'Nothing to create — try describing your request more clearly' },

  // ShadowContext / indexing
  { match: 'Indexing repository',         plain: 'Reading your project to understand its structure' },
  { match: 'Reindex',                     plain: 'Re-read your project files' },
  { match: 'repo index',                  plain: 'project map' },
  { match: 'ShadowContext',               plain: 'Project Reader' },
  { match: 'cached snapshot',             plain: 'saved copy of your project structure' },
  { match: 'Context index unavailable',   plain: 'Could not read your project — generating without context' },
  { match: 'Fetching ambient context',    plain: 'Looking at your existing code for reference' },

  // File generation
  { match: 'Generating',                  plain: 'Writing' },
  { match: 'patch mode',                  plain: 'updating your existing code' },
  { match: 'replace mode',                plain: 'rewriting the file from scratch' },
  { match: 'Reading',                     plain: 'Loading your existing' },
  { match: 'fetch failed, will create',   plain: 'File not found — will create it from scratch' },
  { match: 'will create',                 plain: 'will create as a new file' },
  { match: 'truncated',                   plain: 'the response was cut off — requesting the rest' },
  { match: 'continuing',                  plain: 'getting the rest of the code' },
  { match: 'continuation failed',         plain: 'Could not get the full code — saving what was received' },

  // Remediation / testing
  { match: 'Testing — clean',             plain: 'Checked the code — no issues found ✓' },
  { match: 'Testing',                     plain: 'Checking code for problems' },
  { match: 'Auto-fix attempt',            plain: 'Trying to fix a problem automatically' },
  { match: 'Auto-remediation',            plain: 'Automatic code fix' },
  { match: 'no progress — stopping',      plain: 'Could not improve further — keeping current version' },
  { match: 'max attempts reached',        plain: 'Tried my best — some issues remain (marked in the code)' },
  { match: 'eslint',                      plain: 'code style checker' },
  { match: 'ts-node',                     plain: 'TypeScript checker' },
  { match: 'Pyodide',                     plain: 'Python runner' },
  { match: 'eslint unavailable',          plain: 'Code checker not available — skipping style check' },
  { match: 'Pyodide unavailable',         plain: 'Python checker not available — skipping test' },
  { match: 'lint',                        plain: 'code style check' },
  { match: 'remediat',                    plain: 'fix code problems' },

  // Git / push / GitHub
  { match: 'Branch',                      plain: 'Version branch (a separate copy of your code)' },
  { match: 'branch',                      plain: 'version branch' },
  { match: 'push',                        plain: 'save to GitHub' },
  { match: 'Push',                        plain: 'Save to GitHub' },
  { match: 'commit',                      plain: 'save point' },
  { match: 'pull request',                plain: 'change request (to merge your new code)' },
  { match: 'PR',                          plain: 'change request' },
  { match: 'Waiting for CI',              plain: 'Waiting for automated checks to finish' },
  { match: 'CI:',                         plain: 'Automated check:' },
  { match: 'workflow',                    plain: 'automated check' },
  { match: 'dispatch',                    plain: 'trigger' },
  { match: 'dry run',                     plain: 'preview (no real changes saved)' },
  { match: 'Dry run',                     plain: 'Preview mode — no real changes saved' },
  { match: 'repo',                        plain: 'project' },
  { match: 'SHA',                         plain: 'file version ID' },

  // Errors
  { match: '401',                         plain: 'access denied — check your key' },
  { match: '403',                         plain: 'not allowed — check your permissions' },
  { match: '404',                         plain: 'not found — check the project name' },
  { match: '429',                         plain: 'too many requests — waiting before retrying' },
  { match: 'Rate limit',                  plain: 'Too many requests — waiting before retrying' },
  { match: 'AbortError',                  plain: 'Stopped by user' },
  { match: 'Watchdog',                    plain: '⚠ Timed out — something got stuck, resetting' },
  { match: 'context window',              plain: 'request too large for the AI' },
  { match: 'token',                       plain: 'word unit (how AIs measure text length)' },
  { match: 'undefined reference',         plain: 'using something that was never defined' },
  { match: 'runtime bug',                 plain: 'error that happens when the code runs' },
  { match: 'static analysis',             plain: 'automatic code review' },

  // Misc
  { match: 'exec bridge',                 plain: 'computer connection (for running real commands)' },
  { match: 'Exec bridge',                 plain: 'Computer connection' },
  { match: 'sessionStorage',              plain: 'temporary browser storage' },
  { match: 'localStorage',               plain: 'saved browser storage' },
  { match: 'XOR-encrypted',              plain: 'encrypted' },
  { match: 'BLUSWAN.md',                   plain: 'Project Instructions file' },
  { match: 'repo root',                  plain: "your project's main folder" },
]

/**
 * Translate a raw activity/log message to plain English.
 * If simple mode is off, returns the original string unchanged.
 * @param {string} raw — the technical string from BLUSWAN internals
 * @returns {string}
 */
export function translateActivity(raw) {
  if (!raw || !isSimpleMode()) return raw
  let result = raw
  for (const { match, plain } of ACTIVITY_MAP) {
    // Case-insensitive replace all occurrences
    try {
      result = result.replace(new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), plain)
    } catch { /* skip bad regex */ }
  }
  return result
}

// ── Error translations ─────────────────────────────────────────────────────────
// Each entry describes the error in human terms with a clear "what to do next" action.
// Used in repair engine messages, activity log, and toast notifications.

export const ERROR_TRANSLATIONS = {
  'no-api-key': {
    headline: 'No AI key set up yet',
    body: 'You need an AI access key to use BLUSWAN. It lets BLUSWAN connect to the AI that writes your code.',
    action: 'Open Settings → AI Models → paste your key',
    howToGet: 'Get a free key at anthropic.com (for Claude) or openai.com (for GPT-4o).',
  },
  'api-401': {
    headline: 'AI key not accepted',
    body: 'The AI rejected your access key. It may be typed wrong, expired, or cancelled.',
    action: 'Open Settings → AI Models → check your key and re-paste it',
    howToGet: null,
  },
  'api-403': {
    headline: 'Not allowed to do that',
    body: 'Your account does not have permission for this action.',
    action: 'Check that your key has the right permissions, or contact your AI provider',
    howToGet: null,
  },
  'api-429': {
    headline: 'Too many requests — taking a short break',
    body: 'You\'ve used the AI a lot in a short time. BLUSWAN is automatically waiting and will try again.',
    action: 'Wait a moment — BLUSWAN will retry on its own',
    howToGet: null,
  },
  'api-500-stream': {
    headline: 'The AI had a problem',
    body: 'The AI service had an internal error while writing your code. This is not your fault.',
    action: 'Click Retry — if it keeps happening, try again in a few minutes',
    howToGet: null,
  },
  'network-disconnect': {
    headline: 'Internet connection lost',
    body: 'BLUSWAN lost its internet connection while writing your code. Your partial code has been saved.',
    action: 'Check your internet connection, then click Retry',
    howToGet: null,
  },
  'context-overflow': {
    headline: 'Request too large for the AI',
    body: 'Your project or request is too big for the AI to handle in one go.',
    action: 'Try asking for fewer files at once, or describe a smaller change',
    howToGet: null,
  },
  'planner-json-error': {
    headline: 'Trouble understanding the plan',
    body: 'BLUSWAN had difficulty deciding which files to create. It will try with a simpler approach.',
    action: 'Nothing to do — BLUSWAN is retrying automatically',
    howToGet: null,
  },
  'planner-empty': {
    headline: 'No files to create',
    body: 'BLUSWAN could not figure out what to build from your description.',
    action: 'Try describing what you want in more detail — e.g. "Create a login page with email and password"',
    howToGet: null,
  },
  'per-file-error': {
    headline: 'One file had a problem',
    body: 'BLUSWAN could create most files, but one had an error.',
    action: 'Click the ↺ retry button on the failed file tab to try again',
    howToGet: null,
  },
  'all-files-error': {
    headline: 'Nothing was created',
    body: 'All files failed to generate. This is usually an AI key or connection problem.',
    action: 'Check your AI key in Settings, then try again',
    howToGet: null,
  },
  'push-401': {
    headline: 'GitHub did not accept your key',
    body: 'Your GitHub access key is wrong, expired, or does not have the right permissions.',
    action: 'Open Settings → GitHub Key → get a new key from github.com/settings/tokens',
    howToGet: 'At GitHub: Settings → Developer settings → Personal access tokens → Generate new token (check the "repo" box)',
  },
  'push-403': {
    headline: 'Not allowed to save to GitHub',
    body: 'Your GitHub key exists but does not have permission to write to this project.',
    action: 'Generate a new GitHub key with "repo" access at github.com/settings/tokens',
    howToGet: 'At GitHub: Settings → Developer settings → Personal access tokens → Generate new token → check the "repo" box',
  },
  'push-404': {
    headline: 'GitHub project not found',
    body: 'The project name or owner you entered does not exist on GitHub.',
    action: 'Open Settings → double-check the GitHub URL or project name',
    howToGet: null,
  },
  'push-conflict': {
    headline: 'Someone else changed the code at the same time',
    body: 'The file was updated on GitHub since BLUSWAN last read it.',
    action: 'BLUSWAN will refresh and retry automatically — nothing to do',
    howToGet: null,
  },
  'abort-mid': {
    headline: 'Stopped',
    body: 'You stopped the generation. Any files that finished are still available.',
    action: 'Click Generate again whenever you\'re ready',
    howToGet: null,
  },
  'watchdog': {
    headline: 'Something got stuck — reset complete',
    body: 'BLUSWAN noticed it was taking too long and reset itself. Everything is ready to try again.',
    action: 'Click Generate to try again. If it keeps happening, try a simpler request.',
    howToGet: null,
  },
  'ambient-context-fail': {
    headline: 'Could not read your project first',
    body: 'BLUSWAN usually reads your existing code before writing new code. It could not do that this time, so the code may not match your project perfectly.',
    action: 'Check your GitHub connection in Settings, then click "Refresh project" and try again',
    howToGet: null,
  },
  'remediation-max-attempts': {
    headline: 'Some small issues remain in the code',
    body: 'BLUSWAN tried its best to fix all code issues automatically, but a few could not be resolved.',
    action: 'The code still works in most cases. You can ask BLUSWAN to "Fix the remaining errors" in the refine bar.',
    howToGet: null,
  },
  'storage-quota': {
    headline: 'Browser storage is full',
    body: 'Your browser\'s storage is full so BLUSWAN could not save the project map. It will work without it.',
    action: 'Clear your browser cache or close other tabs. BLUSWAN will continue without the saved map.',
    howToGet: null,
  },
  'agent-max-turns': {
    headline: 'BLUSWAN finished its maximum work session',
    body: 'BLUSWAN can only take a limited number of steps in one session to stay safe.',
    action: 'Review what was done. If more work is needed, start a new request describing the next step.',
    howToGet: null,
  },
  'editblock-no-match': {
    headline: 'Could not find the exact spot to update',
    body: 'BLUSWAN tried to change a specific part of your code but could not locate it exactly.',
    action: 'The change was added at the end of the file instead. Review and move it if needed.',
    howToGet: null,
  },
}

/**
 * Get the plain-English error description for an error code.
 * Falls back to a generic friendly message for unknown codes.
 * @param {string} code
 * @returns {{ headline, body, action, howToGet }}
 */
export function translateError(code) {
  return ERROR_TRANSLATIONS[code] || {
    headline: 'Something unexpected happened',
    body: 'BLUSWAN encountered an unusual problem but is still running.',
    action: 'Try again. If it keeps happening, try a simpler request.',
    howToGet: null,
  }
}

// ── Plain-English UI label overrides ─────────────────────────────────────────
// Import SIMPLE_LABELS and use with t() in JSX:
//   import { SIMPLE_LABELS } from './bluswanSimpleMode'
//   <label>{t('GitHub Token (PAT)', SIMPLE_LABELS.githubToken)}</label>

export const SIMPLE_LABELS = {
  // Settings
  githubToken:       'GitHub Access Key',
  githubTokenHint:   'Lets BLUSWAN save code to your GitHub project. Get one at github.com/settings/tokens (check the "repo" box).',
  githubTokenScope:  'Needs permission to access your projects',
  baseBranch:        'Main branch name',
  baseBranchHint:    'Usually "main" or "master" — the primary version of your code.',
  reindex:           'Refresh project',
  reindexHint:       'Re-reads your project files so BLUSWAN stays up to date.',
  autoBranch:        'Create a separate copy of your code for these changes',
  autopr:            'Submit changes for review (GitHub Pull Request)',
  dryRun:            'Preview mode — see what will change before saving',
  pushAuto:          'Save to GitHub automatically',
  pushAsk:           'Ask me before each save to GitHub',
  pushManual:        'Show me exactly what will change before saving',
  bluswanMd:           'Project Instructions',
  bluswanMdHint:       'Write rules here that BLUSWAN should always follow, like "always use dark mode colours" or "keep all pages under 200 lines".',
  bluswanMdSaved:      'Saved to your project\'s main folder',
  generateTests:     'Also create automated tests',
  generateTestsHint: 'BLUSWAN will write a test file alongside your code to check it works correctly.',
  permissionMode:    'How should BLUSWAN save changes?',
  sessionOnly:       'Key is stored for this browser tab only — closes when you close the tab',
  encrypted:         'Encrypted — never stored in files or sent to our servers',

  // Activity feed
  activityTitle:     'What BLUSWAN is doing',
  activityEmpty:     'Nothing running yet — describe what you want in the box below.',

  // Code pane
  codePaneReady:     'Ready to create code',
  codePaneHint:      'Describe what you want in plain English. BLUSWAN will write the code automatically.',
  refinePlaceholder: 'Describe what to change — e.g. "make the button blue" or "add a loading spinner"',
  refineButton:      'Update',
  ctrlEnter:         'Press Enter to send (Shift+Enter for newline)',

  // Tools pane
  runTests:          'Run automated tests',
  runTestsHint:      'Checks that your code works correctly.',
  runLinter:         'Check code style',
  runLinterHint:     'Looks for formatting problems and common mistakes.',
  runBuild:          'Compile project',
  runBuildHint:      'Turns your code into a version ready for the web.',
  installDeps:       'Install required libraries',
  installDepsHint:   'Downloads extra code that your project needs.',
  gitStatus:         'See what changed',
  gitStatusHint:     'Shows which files have been added or updated.',
  gitLog:            'See recent changes',
  gitLogHint:        'Shows the last 10 save points in your project.',
  customCmd:         'Run a custom command',
  customCmdExample:  'e.g. npm test, npm run build',
  bridgeOnline:      'Connected to your computer — all tools available',
  bridgeOffline:     'Not connected to your computer — start the development server to use tools',

  // Terminal
  terminalHint:      'Run code or commands here. JavaScript and Python work instantly. Other commands need a server connection.',
  terminalPlaceholder: 'Type code to run — e.g.  2+2  or  python: print("hello")',
  terminalTimeout:   'Code took too long to run (20 second limit) — try simplifying it.',

  // Diff viewer
  diffTitle:         'What changed in your code',
  diffAdded:         'Added lines (green)',
  diffRemoved:       'Removed lines (red)',
  diffApplied:       '✓ Change applied',
  diffNotFound:      '✗ Could not apply — check manually',
  diffEmpty:         'No changes yet — generate some code first.',

  // Push / GitHub
  pushButton:        'Save to GitHub',
  pushSuccess:       'Saved to GitHub ✓',
  ciWaiting:         'Checking your code with GitHub automated tests…',
  ciPassed:          'All checks passed ✓',
  ciFailed:          'Some checks failed — review the details',

  // Permission dialog
  permDialogTitle:   'Ready to save your code to GitHub',
  permDialogBody:    'BLUSWAN will create a new version branch and save the generated files.',
  permDialogConfirm: 'Yes, save to GitHub',
  permDialogCancel:  'Not yet',

  // Tokens / cost
  costLabel:         'Estimated AI usage',
  costHint:          'AIs count text in "tokens" — roughly 1 token ≈ ¾ of a word.',

  // Mode toggle (in Settings)
  expertModeLabel:   'Switch to Expert Mode',
  expertModeHint:    'Shows technical labels and full developer details. You can switch back any time.',
  simpleModeLabel:   'Switch to Simple Mode',
  simpleModeHint:    'Plain-English labels and step-by-step guidance. Recommended for most users.',

  // Model selector
  modelLabel:        'AI model',
  modelHint:         'Choose which AI to use. Claude Sonnet is recommended for most tasks.',
}

// ── Non-coder example prompts ─────────────────────────────────────────────────
// Shown in the prompt area when simple mode is on.
// Intentionally written as a non-coder would naturally phrase them.

export const SIMPLE_EXAMPLES = [
  // Beginner / visual
  { label: 'Landing page',      prompt: 'Make a simple website homepage with a headline, a short description, and a blue "Get Started" button.' },
  { label: 'Contact form',      prompt: 'Add a contact form with fields for name, email, and message, and a send button.' },
  { label: 'Dark mode button',  prompt: 'Add a button that switches the website between light and dark mode.' },
  { label: 'Image gallery',     prompt: 'Create a photo gallery that shows images in a grid. Clicking one should make it bigger.' },
  { label: 'Loading spinner',   prompt: 'Show a spinning loading icon while the page is fetching data.' },

  // Simple features
  { label: 'Login page',        prompt: 'Create a login page with an email address field, a password field, and a login button.' },
  { label: 'Sign up flow',      prompt: 'Create a sign-up page where users can enter their name, email, and password to create an account.' },
  { label: 'Countdown timer',   prompt: 'Build a countdown timer that counts down from 10 minutes and shows an alert when it reaches zero.' },
  { label: 'To-do list',        prompt: 'Make a to-do list where I can type a task, add it to a list, and tick it off when done.' },
  { label: 'Weather display',   prompt: 'Show the current weather for a city using an API. Display temperature, condition, and an icon.' },

  // Content
  { label: 'Blog card',         prompt: 'Create a card that shows a blog post with a title, a short description, and a "Read more" button.' },
  { label: 'Pricing table',     prompt: 'Add a pricing section with three plans: Free, Pro, and Business, each with a feature list and a sign-up button.' },
  { label: 'FAQ section',       prompt: 'Add a frequently-asked-questions section where each question expands when clicked to show the answer.' },
  { label: 'Star rating',       prompt: 'Add a star rating component where users can click 1–5 stars to leave a rating.' },
  { label: 'Search bar',        prompt: 'Add a search bar that filters a list of items as the user types.' },

  // Fixes / improvements
  { label: 'Fix slow loading',  prompt: 'The page loads slowly. Find anything that could be slowing it down and speed it up.' },
  { label: 'Mobile friendly',   prompt: 'Make the website look good on mobile phones, not just desktop screens.' },
  { label: 'Fix broken button', prompt: 'The submit button doesn\'t do anything when clicked. Fix it so it submits the form.' },
  { label: 'Add error message', prompt: 'If the user leaves a required field empty and clicks submit, show a clear error message next to that field.' },
  { label: 'Better colours',    prompt: 'Update the colour scheme to use a navy blue and gold palette throughout the website.' },
]

// ── Plain-English pipeline phase explanations ─────────────────────────────────
// Shown as tooltips or help text next to each activity phase icon.

export const PHASE_EXPLANATIONS = {
  amplifying: {
    name:  'Understanding your request',
    what:  'BLUSWAN is reading your description and filling in technical details so the AI can do it correctly.',
    why:   'Plain-English descriptions need to be translated into precise instructions for the AI.',
  },
  planning: {
    name:  'Planning the work',
    what:  'BLUSWAN is deciding which files to create or update based on your request.',
    why:   'Even a simple feature might need changes to several files at once.',
  },
  indexing: {
    name:  'Reading your project',
    what:  'BLUSWAN is scanning your project\'s files to understand how it\'s structured.',
    why:   'This helps BLUSWAN write code that fits your existing style and avoids conflicts.',
  },
  generating: {
    name:  'Writing the code',
    what:  'The AI is writing the actual code based on your request and your project\'s style.',
    why:   'This is the main step — the AI produces complete, ready-to-use code.',
  },
  remediating: {
    name:  'Checking and fixing the code',
    what:  'BLUSWAN is automatically reviewing the code it wrote and fixing any mistakes it finds.',
    why:   'AI-generated code sometimes has small errors. This step catches them before you see the code.',
  },
  testing: {
    name:  'Running a quick check',
    what:  'BLUSWAN is running the code in a safe test environment to make sure it works.',
    why:   'Better to catch problems here than after saving to your project.',
  },
  pushing: {
    name:  'Saving to GitHub',
    what:  'BLUSWAN is saving the finished code to your GitHub project as a new version.',
    why:   'Saving to GitHub keeps a history and lets you review changes before using them.',
  },
  ci: {
    name:  'Waiting for automated checks',
    what:  'GitHub is running automated tests on your code to make sure nothing is broken.',
    why:   'These checks catch issues that only appear when the whole project is built together.',
  },
}

// ── Plain-English tips ────────────────────────────────────────────────────────
// Contextual tips shown during each pipeline phase.

export const SIMPLE_TIPS = [
  // Setup tips
  {
    id: 'tip-github-key',
    trigger: 'no-github',
    headline: 'Connect to GitHub to save your code',
    body: 'Without a GitHub connection, BLUSWAN can still write code — but it won\'t be saved anywhere. To save, you need a GitHub account and an access key.',
    link: { label: 'How to get a GitHub key', url: 'https://github.com/settings/tokens' },
  },
  {
    id: 'tip-api-key',
    trigger: 'no-api-key',
    headline: 'Add an AI key to start generating',
    body: 'BLUSWAN uses an AI model to write code. You need a key from the AI provider (like Anthropic or OpenAI) to unlock this.',
    link: { label: 'Get a Claude key (recommended)', url: 'https://console.anthropic.com/' },
  },

  // First-use tips
  {
    id: 'tip-first-prompt',
    trigger: 'first-use',
    headline: 'Write in plain English — no coding needed',
    body: 'Just describe what you want, like you\'re talking to a person. "Add a dark mode button" or "Create a login form with email and password" are perfect prompts.',
  },
  {
    id: 'tip-refine',
    trigger: 'first-generate',
    headline: 'Not quite right? Use the Update bar',
    body: 'After BLUSWAN creates code, you can ask it to adjust anything. Try "make the button bigger" or "change the colour to red". Each update builds on the previous one.',
  },
  {
    id: 'tip-retry',
    trigger: 'file-error',
    headline: 'One file failed — you can retry just that one',
    body: 'Click the ↺ button on the failed file tab to regenerate only that file. The others are fine.',
  },

  // Context tips
  {
    id: 'tip-what-is-branch',
    trigger: 'branch-created',
    headline: 'A "branch" is a separate copy of your code',
    body: 'Think of it like a draft. Your main code is untouched until you (or your team) decide to merge the draft in. BLUSWAN creates a new branch for every set of changes.',
  },
  {
    id: 'tip-what-is-pr',
    trigger: 'pr-created',
    headline: 'A "change request" lets you review before merging',
    body: 'GitHub shows you exactly what changed. You (or a teammate) can approve it before it becomes part of your main code. You can also just close it if you don\'t want the changes.',
  },
  {
    id: 'tip-what-is-ci',
    trigger: 'ci-running',
    headline: 'Automated checks are running',
    body: 'Your project may have automated tests that verify everything still works. BLUSWAN is waiting for them to finish. Green = all good. Red = something needs attention.',
  },
  {
    id: 'tip-diff',
    trigger: 'diff-shown',
    headline: 'Green lines were added. Red lines were removed.',
    body: 'The "Changes" tab shows exactly what BLUSWAN did to each file. Green = new code added. Red = old code removed. Grey = unchanged.',
  },

  // Error tips
  {
    id: 'tip-timeout',
    trigger: 'watchdog',
    headline: 'The request timed out — this sometimes happens',
    body: 'BLUSWAN automatically reset. Try again with a slightly smaller or simpler request.',
  },
]

// ── Onboarding checklist ───────────────────────────────────────────────────────
// A step-by-step list of what a non-coder needs to do before using BLUSWAN.
// Each step has a check function so the UI can mark it complete automatically.

export const ONBOARDING_STEPS = [
  {
    id:       'step-model',
    title:    'Choose an AI model',
    detail:   'BLUSWAN needs access to an AI to write code. Claude Sonnet (by Anthropic) is recommended — it\'s fast and accurate.',
    action:   'Open Settings → AI Models → add a key',
    link:     { label: 'Get a free Claude key', url: 'https://console.anthropic.com/' },
    check:    (settings) => !!settings?.models?.some(m => m.apiKey),
  },
  {
    id:       'step-github-account',
    title:    'Have a GitHub account',
    detail:   'GitHub is a free service that stores your code safely online. You\'ll need an account to save BLUSWAN\'s output.',
    action:   'Sign up for free at github.com',
    link:     { label: 'Create a GitHub account', url: 'https://github.com/signup' },
    check:    () => true,  // Cannot auto-check — user must confirm
    manual:   true,
  },
  {
    id:       'step-github-token',
    title:    'Add a GitHub access key',
    detail:   'A GitHub access key (called a PAT) lets BLUSWAN save code to your account. It\'s like a password just for BLUSWAN.',
    action:   'Open Settings → GitHub Key → paste the key',
    link:     { label: 'Generate a GitHub key (check the "repo" box)', url: 'https://github.com/settings/tokens/new?scopes=repo' },
    check:    (settings) => !!settings?.githubToken,
  },
  {
    id:       'step-repo',
    title:    'Set your project (GitHub repository)',
    detail:   'Tell BLUSWAN which GitHub project to work on. Paste the GitHub URL of your project.',
    action:   'Open Settings → paste your GitHub project URL (e.g. github.com/yourname/yourproject)',
    link:     null,
    check:    (settings) => !!(settings?.repoOwner && settings?.repoName),
  },
  {
    id:       'step-first-prompt',
    title:    'Try your first request',
    detail:   'Type what you want in plain English and press Enter to send (Shift+Enter for newline), or click Generate. For example: "Add a contact form with name, email, and message fields."',
    action:   'Type in the main input and press Generate',
    link:     null,
    check:    (settings) => !!settings?.hasGenerated,
  },
]

/**
 * Get a list of incomplete onboarding steps given current settings.
 * @param {object} settings — current BLUSWAN settings object
 * @returns {Array} incomplete steps
 */
export function getIncompleteSteps(settings = {}) {
  return ONBOARDING_STEPS.filter(step => !step.check(settings))
}

/**
 * True when all non-manual onboarding steps are complete.
 * @param {object} settings
 * @returns {boolean}
 */
export function isOnboardingComplete(settings = {}) {
  return ONBOARDING_STEPS
    .filter(s => !s.manual)
    .every(s => s.check(settings))
}

// ── Plain-English BLUSWAN.md template ──────────────────────────────────────────
// Default content shown in the BLUSWAN.md editor for non-coders.
// Written in bullet points that non-coders naturally write.

export const SIMPLE_BLUSWAN_MD_TEMPLATE = `# My Project Rules

<!-- BLUSWAN reads this file before every code generation. Write rules in plain English. -->

## Style
- Use simple, readable names for everything — no abbreviations
- Add a short comment above every function explaining what it does
- Keep each file under 200 lines — split larger things into separate files

## Design
- Use the colour scheme: primary = #2563EB (blue), background = #F9FAFB, text = #111827
- All text should be at least 16px in size
- Buttons should have rounded corners and a hover effect

## Features
- All forms must show clear error messages if a field is left empty
- Pages should show a loading state while data is being fetched
- All images must have alt text for accessibility

## Don't
- Do not use external libraries unless absolutely necessary
- Do not add features I did not ask for
`

export default {
  isSimpleMode,
  enableSimpleMode,
  disableSimpleMode,
  toggleSimpleMode,
  t,
  translateActivity,
  translateError,
  SIMPLE_LABELS,
  SIMPLE_EXAMPLES,
  PHASE_EXPLANATIONS,
  SIMPLE_TIPS,
  ONBOARDING_STEPS,
  getIncompleteSteps,
  isOnboardingComplete,
  SIMPLE_BLUSWAN_MD_TEMPLATE,
  ERROR_TRANSLATIONS,
}
