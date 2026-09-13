import { spawn } from 'node:child_process';

export function receiveSyphon(executable, publisherName, count = 3, launch = spawn) {
  return new Promise((resolve, reject) => {
    const duration = typeof count === 'object' ? count.seconds : 0;
    const timeoutMs = duration ? duration * 1000 + 15000 : 15000;
    const args = duration ? [publisherName, count.animated ? '--animated-seconds' : '--seconds', String(duration), String(timeoutMs)]
      : [publisherName, String(count), String(timeoutMs)];
    const receiver = launch(executable, args, { timeout: timeoutMs + 5000, killSignal: 'SIGKILL' });
    let text = '';
    receiver.stdout.on('data', chunk => { text += chunk; });
    receiver.stderr.on('data', chunk => { text += chunk; });
    receiver.once('error', reject);
    // exit does not mean stdout/stderr have drained. Parsing there can truncate
    // a successful native oracle's final report and retire its build too early.
    receiver.once('close', (code, signal) => {
      if (code !== 0) { reject(new Error(`Independent Syphon receiver failed ${code}/${signal}: ${text}`)); return; }
      try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
    });
  });
}
