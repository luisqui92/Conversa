import { createInterface, emitKeypressEvents } from 'node:readline';
export function prompt(text) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(text, (value) => {
      rl.close();
      resolve(value.trim());
    });
  });
}
export function hidden(text) {
  if (!process.stdin.isTTY) throw new Error('Ejecuta esta operación en una terminal interactiva.');
  return new Promise((resolve) => {
    let value = '';
    process.stdout.write(text);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const listener = (text, key) => {
      if (key?.ctrl && key.name === 'c') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (['return', 'enter'].includes(key?.name)) {
        process.stdin.off('keypress', listener);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(value.trim());
      } else if (key?.name === 'backspace') value = value.slice(0, -1);
      else if (
        text &&
        !key?.ctrl &&
        !key?.meta &&
        !/[\x00-\x1f\x7f]/.test(text) &&
        value.length + text.length <= 8192
      )
        value += text;
    };
    process.stdin.on('keypress', listener);
  });
}
