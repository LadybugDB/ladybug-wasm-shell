import lbug from './lib/index.js';

lbug.setWorkerPath('./lib/lbug_wasm_worker.js');

const terminal = document.getElementById('terminal');
const input = document.getElementById('command-input');
const statusEl = document.getElementById('status');
const wasmCoreVersionEl = document.getElementById('wasm-core-version');
const openUrlButton = document.getElementById('open-url-button');
const openUrlDialog = document.getElementById('open-url-dialog');
const openUrlForm = document.getElementById('open-url-form');
const openUrlInput = document.getElementById('open-url-input');
const openUrlCancelButton = document.getElementById('open-url-cancel-button');
const resetDbButton = document.getElementById('reset-db-button');

let db = null;
let conn = null;
let commandHistory = [];
let historyIndex = -1;
let opfsMounted = false;
let resetInProgress = false;

const OPFS_MOUNT_PATH = '/opfs';
const DATABASE_NAME = 'ladybug-shell';
const DATABASE_PATH = `${OPFS_MOUNT_PATH}/${DATABASE_NAME}`;
const RESET_STEP_TIMEOUT_MS = 3000;
const OPFS_DELETE_RETRIES = 10;
const OPFS_DELETE_RETRY_DELAY_MS = 500;
const RESET_PENDING_KEY = 'ladybug-shell-reset-pending';
const OPEN_DATABASE_TIMEOUT_MS = 1000;

wasmCoreVersionEl.textContent = `wasm-core ${__WASM_CORE_VERSION__}`;

function print(text, className = '') {
  const line = document.createElement('div');
  line.className = `output-line ${className}`;
  line.textContent = text;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function printTable(rows) {
  if (!rows || rows.length === 0) {
    print('(empty result)', 'info');
    return;
  }

  const line = document.createElement('div');
  line.className = 'output-line result';

  let html = '<table>';

  const headers = Object.keys(rows[0]);
  html += '<thead><tr>';
  for (const h of headers) {
    html += `<th>${h}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const row of rows) {
    html += '<tr>';
    for (const h of headers) {
      const val = row[h];
      html += `<td>${val === null ? 'NULL' : val}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';

  line.innerHTML = html;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

async function runQuery(statement) {
  if (!conn) {
    print('Database not initialized', 'error');
    return false;
  }

  let result = null;

  try {
    result = await conn.query(statement);

    if (!result.isSuccess()) {
      print(`Error: ${await result.getErrorMessage()}`, 'error');
      return false;
    }

    let hasResults = false;
    const rows = [];
    while (result.hasNext()) {
      hasResults = true;
      const row = await result.getNext();
      rows.push(row);
    }

    if (hasResults && rows.length > 0) {
      printTable(rows);
    } else {
      print('OK', 'success');
    }

    await result.close();
    result = null;
    return true;
  } catch (err) {
    print(`Error: ${err.message}`, 'error');
    return false;
  } finally {
    if (result) {
      await result.close().catch(() => {});
    }
  }
}

function isSupportedOpenUrl(url) {
  return /^(https?|s3|xet|file):\/\//i.test(url);
}

function getOpenUrlPathname(url) {
  return url.split(/[?#]/, 1)[0].toLowerCase();
}

function quoteCypherString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function getUrlBasePath(url) {
  const cleanUrl = url.split(/[?#]/, 1)[0];
  const slashIndex = cleanUrl.lastIndexOf('/');
  if (slashIndex === -1) {
    return '';
  }
  return cleanUrl.slice(0, slashIndex);
}

function splitCypherScript(script) {
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    const next = script[i + 1];

    if (lineComment) {
      current += char;
      if (char === '\n') {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        i++;
        blockComment = false;
      }
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === '-' && next === '-') {
      current += char + next;
      i++;
      lineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      current += char + next;
      i++;
      blockComment = true;
      continue;
    }

    if (char === '\'' || char === '"') {
      current += char;
      quote = char;
      continue;
    }

    if (char === ';') {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const statement = current.trim();
  if (statement) {
    statements.push(statement);
  }

  return statements;
}

async function readUrlText(url) {
  if (canFetchUrl(url)) {
    const response = await fetch(resolveFetchUrl(url));
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  if (typeof lbug.FS?.readFile === 'function') {
    const data = await lbug.FS.readFile(url);
    if (typeof data === 'string') {
      return data;
    }
    return new TextDecoder().decode(data);
  }

  throw new Error('This build cannot read this URL as a Cypher script.');
}

function canFetchUrl(url) {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.startsWith('http://') ||
    lowerUrl.startsWith('https://') ||
    lowerUrl.startsWith('xet://') ||
    lowerUrl.startsWith('s3://');
}

function resolveFetchUrl(url) {
  const lowerUrl = url.toLowerCase();

  if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://')) {
    return url;
  }

  if (lowerUrl.startsWith('xet://')) {
    return resolveXetFetchUrl(url);
  }

  if (lowerUrl.startsWith('s3://')) {
    return resolveS3FetchUrl(url);
  }

  throw new Error('This browser build cannot read this URL through JavaScript fetch.');
}

function resolveXetFetchUrl(url) {
  const parts = url.slice('xet://'.length).split('/').filter(Boolean);
  const repoKind = parts[0] === 'datasets' || parts[0] === 'models' ? parts.shift() : null;

  if (parts.length < 4) {
    throw new Error('xet:// URLs must include namespace, repository, revision, and file path.');
  }

  const [namespace, repo, revision, ...pathParts] = parts;
  const repoPrefix = repoKind === 'datasets' ? 'datasets/' : '';
  const path = pathParts.map(encodeURIComponent).join('/');

  return `https://huggingface.co/${repoPrefix}${encodeURIComponent(namespace)}/${encodeURIComponent(repo)}/resolve/${encodeURIComponent(revision)}/${path}`;
}

function resolveS3FetchUrl(url) {
  const withoutScheme = url.slice('s3://'.length);
  const slashIndex = withoutScheme.indexOf('/');
  if (slashIndex === -1) {
    throw new Error('s3:// URLs must include a bucket and object key.');
  }

  const bucket = withoutScheme.slice(0, slashIndex);
  const key = withoutScheme.slice(slashIndex + 1).split('/').map(encodeURIComponent).join('/');
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

async function reopenDefaultDatabase() {
  await closeCurrentDB();
  db = new lbug.Database(DATABASE_PATH);
  conn = new lbug.Connection(db);
  await conn.init();
  statusEl.textContent = 'Ready';
  statusEl.className = 'status ready';
  print(`Reopened persistent storage: OPFS (${DATABASE_PATH})`, 'info');
}

async function executeCypherScript(url) {
  print(`Opening script ${url}`, 'info');

  let script;
  try {
    script = await readUrlText(url);
  } catch (err) {
    print(`Error reading script: ${err.message}`, 'error');
    return;
  }

  const basePath = getUrlBasePath(url);
  if (basePath) {
    const ok = await prependFileSearchPath(basePath);
    if (!ok) {
      return;
    }
  }

  const statements = splitCypherScript(script);
  if (statements.length === 0) {
    print('No Cypher statements found', 'info');
    return;
  }

  print(`Executing ${statements.length} Cypher statement${statements.length === 1 ? '' : 's'} from script`, 'info');

  for (const statement of statements) {
    print(`lbug> ${statement}`, 'info');
    const ok = await runQuery(statement);
    if (!ok) {
      print('Stopped executing script after error', 'error');
      return;
    }
  }
}

async function getCurrentFileSearchPath() {
  let result = null;

  try {
    result = await conn.query("CALL CURRENT_SETTING('file_search_path') RETURN *;");
    if (!result.isSuccess()) {
      throw new Error(await result.getErrorMessage());
    }

    const rows = await result.getAllObjects();
    const row = rows[0] || {};
    return row.file_search_path || Object.values(row)[0] || '';
  } finally {
    if (result) {
      await result.close().catch(() => {});
    }
  }
}

async function prependFileSearchPath(basePath) {
  if (!conn) {
    print('Database not initialized', 'error');
    return false;
  }

  try {
    const currentPath = await getCurrentFileSearchPath();
    const paths = currentPath ? currentPath.split(',').filter(Boolean) : [];
    const nextPath = paths.includes(basePath) ? currentPath : [basePath, ...paths].join(',');
    const ok = await runQuery(`CALL file_search_path=${quoteCypherString(nextPath)}`);
    if (ok) {
      print(`File search path: ${nextPath}`, 'info');
    }
    return ok;
  } catch (err) {
    print(`Error setting file search path: ${err.message}`, 'error');
    return false;
  }
}

async function openDatabaseUrl(url) {
  print(`Opening database ${url}`, 'info');

  if (url.toLowerCase().startsWith('file://')) {
    print('Error opening database: browser shells cannot open host file:// database paths directly. Use an http(s), s3, or xet URL, or import the database into OPFS.', 'error');
    return;
  }

  input.disabled = true;
  openUrlButton.disabled = true;
  resetDbButton.disabled = true;
  statusEl.textContent = 'Opening';
  statusEl.className = 'status loading';

  try {
    await closeCurrentDB();
    db = new lbug.Database(url, 0, 0, true, true, false);
    conn = new lbug.Connection(db);
    await withTimeout(
      conn.init(),
      OPEN_DATABASE_TIMEOUT_MS,
      `Timed out while opening database ${url}.`
    );
    statusEl.textContent = 'Ready';
    statusEl.className = 'status ready';
    print(`Opened read-only database: ${url}`, 'success');
  } catch (err) {
    print(`Error opening database: ${err.message}`, 'error');
    try {
      await reopenDefaultDatabase();
    } catch (reopenErr) {
      print(`Failed to reopen OPFS database: ${reopenErr.message}`, 'error');
      statusEl.textContent = 'Error';
      statusEl.className = 'status error';
    }
  } finally {
    input.disabled = false;
    openUrlButton.disabled = false;
    resetDbButton.disabled = false;
    input.focus();
  }
}

async function openUrl(url) {
  const trimmedUrl = url.trim();

  if (!trimmedUrl) {
    print('Usage: :open <schema.cypher | database.lbdb URL>', 'error');
    return;
  }

  if (!isSupportedOpenUrl(trimmedUrl)) {
    print(`Unsupported URL scheme: ${trimmedUrl}`, 'error');
    return;
  }

  const pathname = getOpenUrlPathname(trimmedUrl);

  if (pathname.endsWith('.cypher')) {
    await executeCypherScript(trimmedUrl);
    return;
  }

  if (pathname.endsWith('.lbdb')) {
    await openDatabaseUrl(trimmedUrl);
    return;
  }

  print('Unsupported file type. :open currently accepts .cypher scripts and .lbdb databases.', 'error');
}

async function initDB() {
  try {
    await applyPendingReset();
    print('Initializing Ladybug database...', 'info');

    if (!opfsMounted) {
      await lbug.FS.mountOpfs(OPFS_MOUNT_PATH);
      opfsMounted = true;
    }

    db = new lbug.Database(DATABASE_PATH);
    conn = new lbug.Connection(db);

    const version = await lbug.getVersion();
    const storageVersion = await lbug.getStorageVersion();

    print(`Ladybug v${version} initialized`, 'success');
    print(`Storage version: ${storageVersion}`, 'info');
    print(`Persistent storage: OPFS (${DATABASE_PATH})`, 'info');
    print('', 'info');
    print('Welcome to the Ladybug Shell!', 'success');
    print('Type "help" for available commands.', 'info');
    print('', 'info');

    statusEl.textContent = 'Ready';
    statusEl.className = 'status ready';

    printExample();
  } catch (err) {
    print(`Failed to initialize: ${err.message}`, 'error');
    statusEl.textContent = 'Error';
    statusEl.className = 'status error';
  }
}

async function closeCurrentDB() {
  const currentConn = conn;
  const currentDb = db;
  conn = null;
  db = null;

  if (currentConn) {
    try {
      await currentConn.close();
    } catch (err) {
      print(`Warning: failed to close connection: ${err.message}`, 'error');
    }
  }

  if (currentDb) {
    try {
      await currentDb.close();
    } catch (err) {
      print(`Warning: failed to close database: ${err.message}`, 'error');
    }
  }
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function terminateWorker() {
  try {
    await withTimeout(
      lbug.close(),
      RESET_STEP_TIMEOUT_MS,
      'Timed out while terminating the WASM worker.'
    );
  } catch (err) {
    print(`Warning: ${err.message}`, 'error');
  }
}

async function removeOpfsEntryWithRetry(root, entryName) {
  let lastError;

  for (let attempt = 1; attempt <= OPFS_DELETE_RETRIES; attempt++) {
    try {
      await withTimeout(
        root.removeEntry(entryName, { recursive: true }),
        RESET_STEP_TIMEOUT_MS,
        `Timed out while deleting OPFS entry ${entryName}.`
      );
      return;
    } catch (err) {
      lastError = err;
      if (attempt === OPFS_DELETE_RETRIES) {
        break;
      }
      await sleep(OPFS_DELETE_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function deleteNativeOpfsContents() {
  if (!navigator.storage?.getDirectory) {
    throw new Error('Native OPFS deletion is not available in this browser.');
  }

  const root = await navigator.storage.getDirectory();
  const deleted = [];

  for await (const entryName of root.keys()) {
    await removeOpfsEntryWithRetry(root, entryName);
    deleted.push(entryName);
  }

  return deleted;
}

async function applyPendingReset() {
  if (window.sessionStorage.getItem(RESET_PENDING_KEY) !== '1') {
    return;
  }

  window.sessionStorage.removeItem(RESET_PENDING_KEY);
  resetDbButton.disabled = true;
  input.disabled = true;
  statusEl.textContent = 'Resetting';
  statusEl.className = 'status loading';

  try {
    print('Deleting persistent OPFS database data before opening the database...', 'info');

    const deletedEntries = await deleteNativeOpfsContents();
    if (deletedEntries.length > 0) {
      print(`Deleted persistent OPFS entries: ${deletedEntries.join(', ')}`, 'success');
    } else {
      print(`No existing persistent OPFS entries found for ${DATABASE_NAME}`, 'info');
    }
  } finally {
    resetDbButton.disabled = false;
    input.disabled = false;
  }
}

async function resetDatabase() {
  if (resetInProgress) {
    print('Database reset is already in progress.', 'info');
    return;
  }

  resetInProgress = true;
  resetDbButton.disabled = true;
  input.disabled = true;
  statusEl.textContent = 'Resetting';
  statusEl.className = 'status loading';

  try {
    print('Resetting database after reload...', 'info');
    window.sessionStorage.setItem(RESET_PENDING_KEY, '1');

    await withTimeout(
      closeCurrentDB(),
      RESET_STEP_TIMEOUT_MS,
      'Timed out while closing the current database.'
    ).catch((err) => {
      print(`Warning: ${err.message}`, 'error');
    });
    await terminateWorker();
    await sleep(OPFS_DELETE_RETRY_DELAY_MS);

    print('Reloading shell to clear database handles...', 'info');
    window.location.reload();
  } catch (err) {
    print(`Failed to reset database: ${err.message}`, 'error');
    statusEl.textContent = 'Error';
    statusEl.className = 'status error';
  } finally {
    resetInProgress = false;
    resetDbButton.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

function printExample() {
  print('=== Strongly Typed Graph (Recommended) ===', 'info');
  print('CREATE NODE TABLE User(name STRING, age INT64, PRIMARY KEY(name));', 'info');
  print('CREATE NODE TABLE City(name STRING, population INT64, PRIMARY KEY(name));', 'info');
  print('CREATE REL TABLE livesIn(FROM User TO City, MANY_ONE);', 'info');
  print('CREATE (u:User {name: "Alice", age: 30}) -[:livesIn]-> (c:City {name: "NYC", population: 8000000});', 'info');
  print('MATCH (u:User)-[:livesIn]->(c:City) RETURN u.name, c.name;', 'info');
  print('', 'info');

  print('=== Open Type Graph (Schema-less) ===', 'info');
  print('create graph mygraph any;', 'info');
  print('use graph mygraph;', 'info');
  print('CREATE (u:User {name: "Alice", age: 30}) -[:livesIn]-> (c:City {name: "NYC", population: 8000000});', 'info');
  print('MATCH (u:User)-[:livesIn]->(c:City) RETURN u.name, c.name;', 'info');
}

async function executeCommand(cmd) {
  const trimmed = cmd.trim();

  if (!trimmed) return;

  const statements = trimmed.split(';').map(s => s.trim()).filter(s => s);

  for (const statement of statements) {
    commandHistory.push(statement);
    historyIndex = commandHistory.length;

    print(`lbug> ${statement}`, 'info');

    if (statement.toLowerCase() === 'help') {
      printHelp();
      continue;
    }

    if (statement.toLowerCase() === 'clear') {
      terminal.innerHTML = '';
      continue;
    }

    if (statement.toLowerCase() === ':schema') {
      await showSchema();
      continue;
    }

    if (statement.toLowerCase() === ':open') {
      await openUrl('');
      continue;
    }

    if (statement.toLowerCase().startsWith(':open ')) {
      await openUrl(statement.slice(':open '.length));
      continue;
    }

    if (statement.toLowerCase() === ':reset') {
      const confirmed = window.confirm(
        `Destructive action: delete all persistent OPFS database data for this shell and create a fresh database at ${DATABASE_PATH}?`
      );
      if (confirmed) {
        await resetDatabase();
      } else {
        print('Database reset cancelled.', 'info');
      }
      continue;
    }

    if (statement.toLowerCase() === 'exit') {
      print('Goodbye!', 'success');
      await lbug.close();
      continue;
    }

    await runQuery(statement);
  }
}

function printHelp() {
  print('Available commands:', 'info');
  print('  help           - Show this help message', 'info');
  print('  clear          - Clear the terminal', 'info');
  print('  :open <url>    - Execute a .cypher script or open a .lbdb database URL', 'info');
  print('  :schema        - Show current schema', 'info');
  print('  :reset         - DESTRUCTIVE: delete persistent OPFS database data and reopen a fresh database', 'info');
  print('  exit           - Close the database and exit', 'info');
  print('', 'info');
  print('Strongly Typed (Recommended):', 'info');
  print('  CREATE NODE TABLE User(name STRING, age INT64, PRIMARY KEY(name));', 'info');
  print('  CREATE NODE TABLE City(name STRING, population INT64, PRIMARY KEY(name));', 'info');
  print('  CREATE REL TABLE livesIn(FROM User TO City, MANY_ONE);', 'info');
  print('  CREATE (u:User {name: "Alice", age: 30}) -[:livesIn]-> (c:City {name: "NYC"});', 'info');
  print('  MATCH (u:User)-[:livesIn]->(c:City) RETURN u.name, c.name;', 'info');
  print('', 'info');
  print('Open Type Graph (Schema-less):', 'info');
  print('  create graph mygraph any;', 'info');
  print('  use graph mygraph;', 'info');
  print('  CREATE (u:User {name: "Alice"}) -[:livesIn]-> (c:City {name: "NYC"});', 'info');
  print('  MATCH (u)-[:livesIn]->(c) RETURN u.name, c.name;', 'info');
}

async function showSchema() {
  if (!conn) {
    print('Database not initialized', 'error');
    return;
  }

  try {
    const result = await conn.query("CALL show_tables() RETURN *;");
    const rows = await result.getAllObjects();
    await result.close();
    if (rows.length === 0) {
      print('No tables found', 'info');
    } else {
      printTable(rows);
    }
  } catch (err) {
    print(`Error: ${err.message}`, 'error');
  }
}

input.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const cmd = input.value;
    input.value = '';
    input.style.height = 'auto';
    await executeCommand(cmd);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (historyIndex > 0) {
      historyIndex--;
      input.value = commandHistory[historyIndex] || '';
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (historyIndex < commandHistory.length - 1) {
      historyIndex++;
      input.value = commandHistory[historyIndex] || '';
    } else {
      historyIndex = commandHistory.length;
      input.value = '';
    }
  }
});

openUrlButton.addEventListener('click', () => {
  openUrlDialog.showModal();
  openUrlInput.focus();
  openUrlInput.select();
});

openUrlCancelButton.addEventListener('click', () => {
  openUrlDialog.close();
  input.focus();
});

openUrlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = openUrlInput.value;
  openUrlDialog.close();
  await executeCommand(`:open ${url}`);
  input.focus();
});

resetDbButton.addEventListener('click', async () => {
  const confirmed = window.confirm(
    `Destructive action: delete all persistent OPFS database data for this shell and create a fresh database at ${DATABASE_PATH}?`
  );
  if (confirmed) {
    await resetDatabase();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
});

initDB();
