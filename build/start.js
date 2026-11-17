// Starter Electron robust (VS Code sætter ELECTRON_RUN_AS_NODE, som ellers ødelægger start)
const { spawn } = require('child_process');
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: require('path').join(__dirname, '..') });
p.on('exit', (c) => process.exit(c ?? 0));
