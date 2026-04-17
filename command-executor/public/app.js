const state = {
  ip: '',
  phase: 'input', // input, phase1, phase2, complete
  phase1Commands: [],
  phase2Commands: [],
  discoveredServices: [],
  currentPhaseIndex: -1,
  history: [],
  activeResult: null,
  loading: false,
  message: '',
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
  if (state.phase === 'phase1') {
    return state.phase1Commands[state.currentPhaseIndex] || null;
  } else if (state.phase === 'phase2') {
    return state.phase2Commands[state.currentPhaseIndex] || null;
  }
  return null;
}

function formatCommand(template, ip) {
  if (!template) return null;
  let cmd = template;
  if (ip) {
    cmd = cmd.replace(/\$\{address\}|\{address\}/g, ip);
    cmd = cmd.replace(/\$\{ipaddress\}|\{ipaddress\}/g, ip);
    cmd = cmd.replace(/\$\{ipaddressv6\}|\{ipaddressv6\}/g, ip);
    cmd = cmd.replace(/\$\{addressv6\}|\{addressv6\}/g, ip);
    cmd = cmd.replace(/\$\{scandir\}|\{scandir\}/g, `results/${ip}/scans`);
    cmd = cmd.replace(/\$\{nmap_extra\}|\{nmap_extra\}/g, '-vv --reason -Pn -T4');
    cmd = cmd.replace(/traceroute_os/g, ' -A --osscan-guess');
  }
  return cmd;
}

function saveResult(entry) {
  setState({
    history: [...state.history, entry],
    activeResult: entry,
    currentPhaseIndex: state.currentPhaseIndex + 1
  });
}

function showMessage(text) {
  setState({ message: text });
}

async function loadPortScanPlugins() {
  try {
    const response = await fetch('/api/phase1/commands');
    const commands = await response.json();
    setState({ phase1Commands: commands });
  } catch (error) {
    showMessage('Failed to load port scan plugins: ' + error.message);
  }
}

async function executePortScan() {
  const command = currentCommand();
  if (!command) return;

  setState({ loading: true, message: '' });

  try {
    const response = await fetch('/api/phase1/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: state.ip, pluginName: command.slug })
    });

    const result = await response.json();

    const commandText = formatCommand(command.commandTemplate || command.name, state.ip) || command.name;

    if (!response.ok) {
      const entry = {
        ...command,
        command: commandText,
        status: 'failed',
        error: result.error || 'Execution failed',
        output: '',
        phase: 'phase1'
      };
      saveResult(entry);
      showMessage(entry.error);
      if (state.currentPhaseIndex >= state.phase1Commands.length) {
        transitionToPhase2();
      }
    } else {
      const entry = {
        ...command,
        command: commandText,
        status: 'executed',
        error: result.stderr || '',
        output: result.stdout || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        services: result.services,
        phase: 'phase1'
      };
      saveResult(entry);
      const allServices = [...state.discoveredServices, ...(result.services || [])];
      setState({ discoveredServices: allServices });

      if (state.currentPhaseIndex >= state.phase1Commands.length) {
        transitionToPhase2();
      }
    }
  } catch (error) {
    const commandText = formatCommand(command.commandTemplate || command.name, state.ip) || command.name;
    const entry = {
      ...command,
      command: commandText,
      status: 'failed',
      error: error.message,
      output: '',
      phase: 'phase1'
    };
    saveResult(entry);
    showMessage(error.message);
  } finally {
    setState({ loading: false });
  }
}

async function transitionToPhase2() {
  if (state.discoveredServices.length === 0) {
    showMessage('No services discovered. Try running additional port scans.');
    return;
  }

  try {
    const response = await fetch('/api/phase2/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ services: state.discoveredServices })
    });

    const commands = await response.json();
    setState({
      phase: 'phase2',
      phase2Commands: commands,
      currentPhaseIndex: 0
    });
  } catch (error) {
    showMessage('Failed to load service scan plugins: ' + error.message);
  }
}

async function executeServiceScan() {
  const command = currentCommand();
  if (!command) return;

  setState({ loading: true, message: '' });

  try {
    const response = await fetch('/api/phase2/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: state.ip, pluginName: command.slug })
    });

    const result = await response.json();
    const commandText = formatCommand(command.commandTemplate || command.name, state.ip) || command.name;

    if (!response.ok) {
      const entry = {
        ...command,
        command: commandText,
        status: 'failed',
        error: result.error || 'Execution failed',
        output: '',
        phase: 'phase2'
      };
      saveResult(entry);
      showMessage(entry.error);
    } else {
      const entry = {
        ...command,
        command: commandText,
        status: 'executed',
        error: result.stderr || '',
        output: result.stdout || '',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        phase: 'phase2'
      };
      saveResult(entry);
    }

    if (state.currentPhaseIndex >= state.phase2Commands.length) {
      setState({ phase: 'complete' });
    }
  } catch (error) {
    const entry = {
      ...command,
      status: 'failed',
      error: error.message,
      output: '',
      phase: 'phase2'
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

  const commandText = formatCommand(command.commandTemplate || command.name, state.ip) || command.name;
  const entry = {
    ...command,
    command: commandText,
    status: 'skipped',
    output: '',
    error: 'Skipped by user.',
    phase: state.phase
  };
  saveResult(entry);

  if (state.phase === 'phase1' && state.currentPhaseIndex >= state.phase1Commands.length) {
    transitionToPhase2();
  } else if (state.phase === 'phase2' && state.currentPhaseIndex >= state.phase2Commands.length) {
    setState({ phase: 'complete' });
  }
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
    phase: 'phase1',
    currentPhaseIndex: 0,
    history: [],
    activeResult: null,
    discoveredServices: [],
    jsonViewActive: false
  });
}

function resetSession() {
  setState({
    ip: '',
    phase: 'input',
    currentPhaseIndex: -1,
    history: [],
    activeResult: null,
    discoveredServices: [],
    message: '',
    jsonViewActive: false
  });
}

function render() {
  const command = currentCommand();
  const isPhase1Complete = state.phase === 'phase1' && state.currentPhaseIndex >= state.phase1Commands.length;
  const isPhase2Complete = state.phase === 'phase2' && state.currentPhaseIndex >= state.phase2Commands.length;
  const isComplete = state.phase === 'complete';

  root.innerHTML = '';

  const app = document.createElement('div');
  app.className = 'app-container';

  const header = document.createElement('header');
  const title = document.createElement('h1');
  title.textContent = 'Fastrecon';
  const subtitle = document.createElement('p');
  if (state.phase === 'input') {
    subtitle.textContent = 'Enter target IP to start scanning.';
  } else if (state.phase === 'phase1') {
    subtitle.textContent = 'Phase 1: Port Scanning';
  } else if (state.phase === 'phase2') {
    subtitle.textContent = `Phase 2: Service Scanning (${state.discoveredServices.length} services found)`;
  } else {
    subtitle.textContent = 'Scan Complete';
  }
  header.append(title, subtitle);
  app.appendChild(header);

  // Input panel
  const inputPanel = document.createElement('section');
  inputPanel.className = 'panel';
  const label = document.createElement('label');
  label.textContent = 'Target IP';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = state.ip;
  input.placeholder = '192.168.1.100';
  input.disabled = state.phase !== 'input';
  input.addEventListener('input', (event) => setState({ ip: event.target.value.trim() }));

  const buttonRow = document.createElement('div');
  buttonRow.className = 'action-row';
  const startButton = document.createElement('button');
  startButton.textContent = 'Start';
  startButton.disabled = state.phase !== 'input' || !state.ip;
  startButton.addEventListener('click', startSession);
  const resetButton = document.createElement('button');
  resetButton.textContent = 'Reset';
  resetButton.disabled = state.phase === 'input';
  resetButton.addEventListener('click', resetSession);
  buttonRow.append(startButton, resetButton);

  inputPanel.append(label, input, buttonRow);
  app.appendChild(inputPanel);

  // Command panel
  if (state.phase !== 'input' && state.phase !== 'complete') {
    const queuePanel = document.createElement('section');
    queuePanel.className = 'panel';
    const queueTitle = document.createElement('h2');
    queueTitle.textContent = state.phase === 'phase1' ? 'Port Scan' : 'Service Scan';
    queuePanel.appendChild(queueTitle);

    const commands = state.phase === 'phase1' ? state.phase1Commands : state.phase2Commands;

    if (!commands.length && state.phase === 'phase1') {
      const loading = document.createElement('p');
      loading.textContent = 'Loading port scan plugins...';
      queuePanel.appendChild(loading);
    } else if (command && !isPhase1Complete && !isPhase2Complete) {
      const commandCard = document.createElement('div');
      commandCard.className = 'command-card';
      const commandText = formatCommand(command.commandTemplate || command.name, state.ip) || command.name;
      const nameField = document.createElement('div');
      nameField.className = 'command-field';
      const nameLabel = document.createElement('strong');
      nameLabel.textContent = 'Command:';
      const nameCode = document.createElement('code');
      nameCode.textContent = commandText;
      nameField.append(nameLabel, nameCode);
      commandCard.appendChild(nameField);
      queuePanel.appendChild(commandCard);

      const queueButtons = document.createElement('div');
      queueButtons.className = 'action-row';
      const execButton = document.createElement('button');
      execButton.textContent = state.loading ? 'Executing...' : 'Execute';
      execButton.disabled = state.loading;
      execButton.addEventListener('click', state.phase === 'phase1' ? executePortScan : executeServiceScan);
      const skipButton = document.createElement('button');
      skipButton.textContent = 'Skip';
      skipButton.disabled = state.loading;
      skipButton.addEventListener('click', skipCommand);
      queueButtons.append(execButton, skipButton);
      queuePanel.appendChild(queueButtons);
    }

    app.appendChild(queuePanel);
  }

  // Results panel
  if (isComplete) {
    const completionPanel = document.createElement('section');
    completionPanel.className = 'panel';
    const completeText = document.createElement('p');
    completeText.textContent = 'Scanning complete.';
    const downloadButton = document.createElement('button');
    downloadButton.textContent = 'Download JSON';
    downloadButton.disabled = state.history.length === 0;
    downloadButton.addEventListener('click', downloadJson);
    const toggleButton = document.createElement('button');
    toggleButton.textContent = state.jsonViewActive ? 'Hide' : 'View Results';
    toggleButton.disabled = state.history.length === 0;
    toggleButton.addEventListener('click', () => setState({ jsonViewActive: !state.jsonViewActive }));
    completionPanel.append(completeText, downloadButton, toggleButton);
    app.appendChild(completionPanel);
  }

  // History panel
  const historyPanel = document.createElement('section');
  historyPanel.className = 'panel';
  const historyTitle = document.createElement('h2');
  historyTitle.textContent = 'Results';
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
    resultTitle.textContent = state.activeResult.command || state.activeResult.name;
    const statusLine = document.createElement('p');
    statusLine.innerHTML = `<strong>Status:</strong> ${state.activeResult.status}`;
    const outputLabel = document.createElement('div');
    outputLabel.innerHTML = '<strong>Output:</strong>';
    const outputPre = document.createElement('pre');
    outputPre.textContent = state.activeResult.output ? state.activeResult.output.substring(0, 500) : '(none)';
    resultCard.append(resultTitle, statusLine, outputLabel, outputPre);

    if (state.activeResult.command) {
      const commandLabel = document.createElement('div');
      commandLabel.innerHTML = '<strong>Executed Command:</strong>';
      const commandPre = document.createElement('pre');
      commandPre.textContent = state.activeResult.command;
      resultCard.append(commandLabel, commandPre);
    }

    if (state.activeResult.services && state.activeResult.services.length > 0) {
      const servicesLabel = document.createElement('div');
      servicesLabel.innerHTML = `<strong>Services Found:</strong>`;
      const servicesList = document.createElement('pre');
      servicesList.textContent = state.activeResult.services.map((s) => `${s.protocol}/${s.port}: ${s.name}`).join('\n');
      resultCard.append(servicesLabel, servicesList);
    }

    historyPanel.appendChild(resultCard);
  }

  if (state.jsonViewActive) {
    const jsonView = document.createElement('div');
    jsonView.className = 'json-view';
    const jsonTitle = document.createElement('h3');
    jsonTitle.textContent = 'Results JSON';
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
loadPortScanPlugins();
