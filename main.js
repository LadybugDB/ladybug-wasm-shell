import lbug from './lib/index.js';

lbug.setWorkerPath('./lib/lbug_wasm_worker.js');

const terminal = document.getElementById('terminal');
const input = document.getElementById('command-input');
const statusEl = document.getElementById('status');
const wasmCoreVersionEl = document.getElementById('wasm-core-version');

let db = null;
let conn = null;
let commandHistory = [];
let historyIndex = -1;

const OPFS_MOUNT_PATH = '/opfs';
const DATABASE_PATH = `${OPFS_MOUNT_PATH}/ladybug-shell`;

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

async function initDB() {
  try {
    print('Initializing Ladybug database...', 'info');

    await lbug.FS.mountOpfs(OPFS_MOUNT_PATH);
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

    if (statement.toLowerCase() === 'exit') {
      print('Goodbye!', 'success');
      await lbug.close();
      continue;
    }

    if (!conn) {
      print('Database not initialized', 'error');
      continue;
    }

    try {
      const result = await conn.query(statement);

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
    } catch (err) {
      print(`Error: ${err.message}`, 'error');
    }
  }
}

function printHelp() {
  print('Available commands:', 'info');
  print('  help           - Show this help message', 'info');
  print('  clear          - Clear the terminal', 'info');
  print('  :schema        - Show current schema', 'info');
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

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
});

initDB();
