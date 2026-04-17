# Command Executor

A simple React/Express command execution system that uses SSH key authentication to execute a predetermined command queue on a remote host.

## Setup

1. Install dependencies:

   ```bash
   cd command-executor
   npm install
   ```

2. Provide SSH environment variables:

   - `SSH_USER` - SSH username (defaults to `ubuntu`)
   - `SSH_PRIVATE_KEY` - private key contents
   - or `SSH_PRIVATE_KEY_PATH` - path to a private key file

3. Start the server:

   ```bash
   npm start
   ```

4. Open the browser at:

   ```text
   http://localhost:3000
   ```

## Features

- Frontend accepts an IP address and displays one command at a time
- Execute or skip each command
- Stores all results in JSON format
- Allows downloading/viewing the JSON results
- Backend validates IP addresses and limits requests
- SSH-only authentication using private keys
- Command execution timeout and error handling
- Operation logging in `logs/operations.log`

## Notes

- The backend only accepts a predefined whitelist of SSH commands in `server.js`.
- Do not expose this service on public networks without additional hardening and authentication.
