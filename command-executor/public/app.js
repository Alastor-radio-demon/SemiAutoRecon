const state = {
  ip: '',
  currentIndex: -1,
  history: [],
  commands: [],
  activeResult: null,
  loading: false,
  message: '',
  sessionStarted: false,
  jsonViewActive: false
};

const root = document.getElementById('root');

function validateIp(value) {
  const ipRegex = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(value)) {
    return false;
  }
  return value.split('.').every((octet) => parseInt(octet, 10) >= 0 && parseInt(octet, 10) <= 255);
}

function setState(partial) {
  Object.assign(state, partial);
  render();
}

function currentCommand() {
  return state.commands[state.currentIndex] || null;
}

function saveResult(entry) {
  setState({
    history: [...state.history, entry],
    activeResult: entry,
    currentIndex: state.currentIndex + 1
  });
}

function showMessage(text) {
  setState({ message: text });
}

async function loadCommands() {
  try {
    const response = await fetch('/api/commands');
    const commands = await response.json();
    setState({ commands });
  } catch (error) {
    showMessage('Failed to load fastrecon plugins: ' + error.message);
  }
}

async function executeCommand() {
  const command = currentCommand();
  if (!command) return;

  setState({ loading: true, message: '' });

  try {
    const response = await fetch('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: state.ip, pluginName: command.slug })
    });

    const result = await response.json();

    if (!response.ok) {
      const entry = {
        ...command,
        status: 'failed',
        error: result.error || 'Execution failed',
        output: ''
      };
      saveResult(entry);
      showMessage(entry.error);
    } else {
      const entry = {
        ...command,
        status: 'executed',
        error: result.stderr || '',
        output: result.stdout || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs
      };
      saveResult(entry);
    }
  } catch (error) {
    const entry = {
      ...command,
      status: 'failed',
      error: error.message,
      output: ''
    };
    saveResult(entry);
    showMessage(error.message);
  } finally {
    setState({ loading: false });
  }
}

function skipCommand() {
  const command = currentCommand();
  if (!command) return;

  const entry = {
    ...command,
    status: 'skipped',
    output: '',
    error: 'Plugin skipped by user.'
  };
  saveResult(entry);
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(state.history, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `fastrecon-results-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function startSession() {
  if (!validateIp(state.ip)) {
    showMessage('Please enter a valid IPv4 address.');
    return;
  }
  setState({
    message: '',
    sessionStarted: true,
    currentIndex: 0,
    history: [],
    activeResult: null,
    jsonViewActive: false
  });
}

function resetSession() {
  setState({
    ip: '',
    currentIndex: -1,
    history: [],
    activeResult: null,
    sessionStarted: false,
    message: '',
    jsonViewActive: false
  });
}

function render() {
  const command = currentCommand();
  const finished = state.sessionStarted && state.currentIndex >= state.commands.length;

  root.innerHTML = '';

  const app = document.createElement('div');
  app.className = 'app-container';

  const header = document.createElement('header');
  const title = document.createElement('h1');
  title.textContent = 'Fastrecon Web Executor';
  const subtitle = document.createElement('p');
  subtitle.textContent = 'Enter an IP address, execute fastrecon plugins one-by-one, and export the results to JSON.';
  header.append(title, subtitle);
  app.appendChild(header);

  const inputPanel = document.createElement('section');
  inputPanel.className = 'panel';
  const label = document.createElement('label');
  label.textContent = 'Target IP address';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = state.ip;
  input.placeholder = '192.168.1.100';
  input.disabled = state.sessionStarted;
  input.addEventListener('input', (event) => setState({ ip: event.target.value.trim() }));

  const buttonRow = document.createElement('div');
  buttonRow.className = 'action-row';
  const startButton = document.createElement('button');
  startButton.textContent = 'Start Session';
  startButton.disabled = state.sessionStarted || !state.ip;
  startButton.addEventListener('click', startSession);
  const resetButton = document.createElement('button');
  resetButton.textContent = 'Reset';
  resetButton.disabled = !state.sessionStarted;
  resetButton.addEventListener('click', resetSession);
  buttonRow.append(startButton, resetButton);

  inputPanel.append(label, input, buttonRow);
  app.appendChild(inputPanel);

  const queuePanel = document.createElement('section');
  queuePanel.className = 'panel';
  const queueTitle = document.createElement('h2');
  queueTitle.textContent = 'Fastrecon Plugins';
  queuePanel.appendChild(queueTitle);

  if (!state.commands.length) {
    const loading = document.createElement('p');
    loading.textContent = 'Loading plugins...';
    queuePanel.appendChild(loading);
  }

  if (state.sessionStarted && !finished && command) {
    const commandCard = document.createElement('div');
    commandCard.className = 'command-card';

    const nameField = document.createElement('div');
    nameField.className = 'command-field';
    const nameLabel = document.createElement('strong');
    nameLabel.textContent = 'Plugin:';
    const nameCode = document.createElement('code');
    nameCode.textContent = command.name;
    nameField.append(nameLabel, nameCode);

    const descField = document.createElement('div');
    descField.className = 'command-field';
    const descLabel = document.createElement('strong');
    descLabel.textContent = 'Description:';
    const descText = document.createElement('span');
    descText.textContent = command.description;
    descField.append(descLabel, descText);

    commandCard.append(nameField, descField);
    queuePanel.appendChild(commandCard);

    const queueButtons = document.createElement('div');
    queueButtons.className = 'action-row';
    const execButton = document.createElement('button');
    execButton.textContent = state.loading ? 'Executing...' : 'Execute';
    execButton.disabled = state.loading;
    execButton.addEventListener('click', executeCommand);
    const skipButton = document.createElement('button');
    skipButton.textContent = 'Skip';
    skipButton.disabled = state.loading;
    skipButton.addEventListener('click', skipCommand);
    queueButtons.append(execButton, skipButton);
    queuePanel.appendChild(queueButtons);
  }

  if (finished) {
    const completion = document.createElement('div');
    completion.className = 'completion';
    const completeText = document.createElement('p');
    completeText.textContent = 'All plugins have been processed.';
    const downloadButton = document.createElement('button');
    downloadButton.textContent = 'Download JSON Results';
    downloadButton.disabled = state.history.length === 0;
    downloadButton.addEventListener('click', downloadJson);
    const toggleButton = document.createElement('button');
    toggleButton.textContent = state.jsonViewActive ? 'Hide Results' : 'View Results';
    toggleButton.disabled = state.history.length === 0;
    toggleButton.addEventListener('click', () => setState({ jsonViewActive: !state.jsonViewActive }));
    completion.append(completeText, downloadButton, toggleButton);
    queuePanel.appendChild(completion);
  }

  if (!state.sessionStarted) {
    const startInfo = document.createElement('p');
    startInfo.textContent = 'Start the session to step through each fastrecon plugin for the target host.';
    queuePanel.appendChild(startInfo);
  }

  app.appendChild(queuePanel);

  const historyPanel = document.createElement('section');
  historyPanel.className = 'panel';
  const historyTitle = document.createElement('h2');
  historyTitle.textContent = 'Execution History';
  historyPanel.appendChild(historyTitle);

  if (state.message) {
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = state.message;
    historyPanel.appendChild(notification);
  }

  if (state.activeResult) {
    const resultCard = document.createElement('div');
    resultCard.className = 'result-card';
    const resultTitle = document.createElement('h3');
    resultTitle.textContent = `Last plugin: ${state.activeResult.name}`;
    const statusLine = document.createElement('p');
    statusLine.innerHTML = `<strong>Status:</strong> ${state.activeResult.status}`;
    const exitLine = document.createElement('p');
    exitLine.innerHTML = `<strong>Exit code:</strong> ${state.activeResult.exitCode != null ? state.activeResult.exitCode : 'N/A'}`;
    const outputLabel = document.createElement('div');
    outputLabel.innerHTML = '<strong>Output:</strong>';
    const outputPre = document.createElement('pre');
    outputPre.textContent = state.activeResult.output || '(no output)';
    const errorLabel = document.createElement('div');
    errorLabel.innerHTML = '<strong>Error:</strong>';
    const errorPre = document.createElement('pre');
    errorPre.textContent = state.activeResult.error || '(none)';
    resultCard.append(resultTitle, statusLine, exitLine, outputLabel, outputPre, errorLabel, errorPre);
    historyPanel.appendChild(resultCard);
  }

  if (state.jsonViewActive) {
    const jsonView = document.createElement('div');
    jsonView.className = 'json-view';
    const jsonTitle = document.createElement('h3');
    jsonTitle.textContent = 'Plugin Results JSON';
    const jsonTextarea = document.createElement('textarea');
    jsonTextarea.readOnly = true;
    jsonTextarea.value = JSON.stringify(state.history, null, 2);
    jsonView.append(jsonTitle, jsonTextarea);
    historyPanel.appendChild(jsonView);
  }

  app.appendChild(historyPanel);
  root.appendChild(app);
}

render();
loadCommands();
