import fs from 'fs';
import path from 'path';

const logDir = path.resolve(process.cwd(), 'logs');
const logFile = path.join(logDir, 'app.log');

if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function color(level) {
  switch(level) {
    case 'ERROR': return '\x1b[31m'; // 红
    case 'WARN': return '\x1b[33m'; // 黄
    case 'INFO': return '\x1b[36m'; // 青
    case 'DEBUG': return '\x1b[35m'; // 紫
    default: return '';
  }
}
function pad(str, len) {
  return (str + ' '.repeat(len)).slice(0, len);
}
function writeLog(level, message, meta) {
  const time = new Date().toISOString();
  const line = `[${time}] [${pad(level,5)}] ${pad(message,18)} | ${meta ? JSON.stringify(meta) : ''}`;
  fs.appendFileSync(logFile, line + '\n');
  // 控制台美化输出
  const c = color(level);
  let metaStr = '';
  if(meta && typeof meta === 'object') {
    metaStr = Object.entries(meta).map(([k,v])=>`${k}=${v}`).join('  ');
  }
  const out = `${c}[${time}] [${pad(level,5)}]\x1b[0m ${message}  ${metaStr}`;
  if (level === 'ERROR') {
    console.error(out);
  } else if (level === 'WARN') {
    console.warn(out);
  } else {
    console.log(out);
  }
}

export const logger = {
  info: (msg, meta) => writeLog('INFO', msg, meta),
  debug: (msg, meta) => writeLog('DEBUG', msg, meta),
  warn: (msg, meta) => writeLog('WARN', msg, meta),
  error: (msg, meta) => writeLog('ERROR', msg, meta),
}; 