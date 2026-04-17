const { useState, useEffect } = React;

function App() {
  const [ip, setIp] = useState('');
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [history, setHistory] = useState([]);
  const [savedCommands, setSavedCommands] = useState([]);
  const [activeResult, setActiveResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [sessionStarted, setSessionStarted] = useState(false);
  const [jsonViewActive, setJsonViewActive] = useState(false);

  useEffect(() => {
    fetch('/api/commands')
      .then((response) => response.json())
      .then(setSavedCommands)
      .catch(() => setMessage('Unable to load command configuration.'));
  }, []);

  function validateIp(value) {
    const ipRegex = /^(?:\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(value)) {
      return false;
    }
    return value.split('.').every((octet) => parseInt(octet, 10) >= 0 && parseInt(octet, 10) <= 255);
  }

  function startSession() {
    if (!validateIp(ip)) {
      setMessage('Please enter a valid IPv4 address.');
      return;
    }

    setMessage('');
    setSessionStarted(true);
    setCurrentIndex(0);
    setHistory([]);
    setActiveResult(null);
    setJsonViewActive(false);
  }

  function currentCommand() {
    return savedCommands[currentIndex] || null;
  }

  function saveResult(entry) {
    setHistory((prev) => [...prev, entry]);
    setActiveResult(entry);
    setCurrentIndex((prevIndex) => prevIndex + 1);
  }

  async function executeCommand() {
    const command = currentCommand();
    if (!command) {
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const response = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, command: command.command })
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
        setMessage(entry.error);
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
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  function skipCommand() {
    const command = currentCommand();
    if (!command) {
      return;
    }

    const entry = {
      ...command,
      status: 'skipped',
      output: '',
      error: 'Command skipped by user.'
    };
    saveResult(entry);
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `command-results-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function resetSession() {
    setIp('');
    setCurrentIndex(-1);
    setHistory([]);
    setActiveResult(null);
    setSessionStarted(false);
    setMessage('');
    setJsonViewActive(false);
  }

  const command = currentCommand();
  const finished = sessionStarted && currentIndex >= savedCommands.length;

  return (
    React.createElement('div', { className: 'app-container' },
      React.createElement('header', null,
        React.createElement('h1', null, 'SSH Command Executor'),
        React.createElement('p', null, 'Enter an IP address, execute commands one-by-one, and export the results to JSON.')
      ),

      React.createElement('section', { className: 'panel' },
        React.createElement('label', null, 'Target IP address'),
        React.createElement('input', {
          type: 'text',
          value: ip,
          onChange: (event) => setIp(event.target.value.trim()),
          disabled: sessionStarted,
          placeholder: '192.168.1.100'
        }),
        React.createElement('div', { className: 'action-row' },
          React.createElement('button', { onClick: startSession, disabled: sessionStarted || !ip }, 'Start Session'),
          React.createElement('button', { onClick: resetSession, disabled: !sessionStarted }, 'Reset')
        )
      ),

      React.createElement('section', { className: 'panel' },
        React.createElement('h2', null, 'Command Queue'),
        !savedCommands.length && React.createElement('p', null, 'Loading commands...'),
        sessionStarted && !finished && command && React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'command-card' },
            React.createElement('div', { className: 'command-field' },
              React.createElement('strong', null, 'Syntax:'),
              React.createElement('code', null, command.syntax)
            ),
            React.createElement('div', { className: 'command-field' },
              React.createElement('strong', null, 'Description:'),
              React.createElement('span', null, command.description)
            )
          ),
          React.createElement('div', { className: 'action-row' },
            React.createElement('button', { onClick: executeCommand, disabled: loading }, loading ? 'Executing...' : 'Execute'),
            React.createElement('button', { onClick: skipCommand, disabled: loading }, 'Skip')
          )
        ),
        finished && React.createElement('div', { className: 'completion' },
          React.createElement('p', null, 'All commands have been processed.'),
          React.createElement('button', { onClick: downloadJson, disabled: history.length === 0 }, 'Download JSON Results'),
          React.createElement('button', { onClick: () => setJsonViewActive((prev) => !prev), disabled: history.length === 0 }, jsonViewActive ? 'Hide Results' : 'View Results')
        ),
        !sessionStarted && React.createElement('p', null, 'Start the session to step through each SSH command for the target host.')
      ),

      React.createElement('section', { className: 'panel' },
        React.createElement('h2', null, 'Execution History'),
        message && React.createElement('div', { className: 'notification' }, message),
        activeResult && React.createElement('div', { className: 'result-card' },
          React.createElement('h3', null, `Last command: ${activeResult.syntax}`),
          React.createElement('p', null, React.createElement('strong', null, 'Status:'), ' ', activeResult.status),
          React.createElement('p', null, React.createElement('strong', null, 'Exit code:'), ' ', activeResult.exitCode != null ? activeResult.exitCode : 'N/A'),
          React.createElement('div', null, React.createElement('strong', null, 'Output:')),
          React.createElement('pre', null, activeResult.output || '(no output)'),
          React.createElement('div', null, React.createElement('strong', null, 'Error:')),
          React.createElement('pre', null, activeResult.error || '(none)')
        ),
        jsonViewActive && React.createElement('div', { className: 'json-view' },
          React.createElement('h3', null, 'Command Results JSON'),
          React.createElement('textarea', {
            readOnly: true,
            value: JSON.stringify(history, null, 2)
          })
        )
      )
    )
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
