import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('Starting IslandDAO Governance Platform...');

// Start the citizen map server (known working configuration)
const mapServer = spawn('node', ['simple-server.cjs'], {
  cwd: __dirname + '/citizen-map',
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.PORT || 5000
  }
});

mapServer.on('error', (error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

mapServer.on('close', (code) => {
  if (code !== 0) {
    console.log(`Server exited with code ${code}`);
    process.exit(code);
  }
});

process.on('SIGTERM', () => {
  mapServer.kill('SIGTERM');
});

process.on('SIGINT', () => {
  mapServer.kill('SIGINT');
});