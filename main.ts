import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import fs from 'fs';
import { CONFIG, loadConfig, saveConfig } from './config';
// import type { AppConfig } from './config.ts'; // 如需类型可解开
import { initDB, createTask, stopTask, getTask, getActiveTask, addIpRecord, getUniqueIpRecords, getAllTasks, getUniqueIpCount, createApiKey, updateApiKeyBalance, deleteApiKey, getApiKey, listApiKeys, consumeApiKey, cleanZeroIpTasks, getTaskLastUpdateTime, getIpRecordsLastUpdateTime, vacuumAndAnalyze, getTasksByKey, updateTaskKey } from './db/sqlite';
import { getClientIp, getIpInfo } from './utils/ip';
import { genTaskId } from './utils/task';
import { logger } from './utils/logger';
import cookieParser from 'cookie-parser';
import sqlite3 from 'sqlite3';
import * as schedule from 'node-schedule';
import { rateLimit } from 'express-rate-limit';
const { Database } = sqlite3;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config = loadConfig();
// 启动时从 config.json 读取限速配置
let RATE_LIMIT_CONFIG = config.RATE_LIMIT_CONFIG || {
  STAT_WINDOW_MS: 24 * 60 * 60 * 1000,
  CLEAN_INTERVAL_MS: 10 * 60 * 1000,
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  RATE_LIMIT_MAX: 10,
  RATE_LIMIT_BAN_TIMES: 3,
  BAN_DURATION_MS: 60 * 60 * 1000
};

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {
  const startTime = Date.now();
  const { method, originalUrl } = req;
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  let body = '';
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    body = JSON.stringify(req.body);
  }
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('请求日志', {
      ip,
      url: originalUrl,
      ua,
      method,
      body,
      status: res.statusCode,
      duration
    });
  });
  next();
});
function isBypassRateLimit(req) {
  // query
  if (req.query && (req.query.key || req.query.token)) return true;
  // header
  if (req.headers && (req.headers['x-api-key'] || req.headers['authorization'] || req.headers['token'] || req.headers['x-token'])) return true;
  // body
  if (req.body && (req.body.key || req.body.token)) return true;
  return false;
}
// 全局请求统计与限速
const requestStats = {
  total: 0,
  perPath: new Map(), // path => count
  perIp: new Map(),   // ip => [{timestamp, path}]
  banIp: new Map(),   // ip => banUntil timestamp
  rate429Map: new Map() // 统计每个IP的429次数
};

// 定时清理统计窗口外的请求记录
setInterval(() => {
  const now = Date.now();
  // 清理perIp
  for (const [ip, arr] of requestStats.perIp.entries()) {
    requestStats.perIp.set(ip, arr.filter(r => now - r.timestamp < RATE_LIMIT_CONFIG.STAT_WINDOW_MS));
  }
  // 清理banIp中过期的
  for (const [ip, banUntil] of requestStats.banIp.entries()) {
    if (now > banUntil) requestStats.banIp.delete(ip);
  }
}, RATE_LIMIT_CONFIG.CLEAN_INTERVAL_MS);

// 限速中间件
function statAndRateLimitV2(req, res, next) {
  if (req.path.startsWith('/webui') || req.path.startsWith('/api/page/')) return next();
  const token = req.cookies?.webui_token || req.headers['x-token'] || req.query.token || req.body?.token;
  if (token === config.ADMIN_TOKEN) return next();
  if (isBypassRateLimit(req)) return next();
  const ip = getClientIp(req);
  const path = req.path;
  const now = Date.now();
  // 封禁检查
  if (requestStats.banIp.has(ip)) {
    const banUntil = requestStats.banIp.get(ip);
    if (now < banUntil) {
      logger.warn('IP被封禁', { ip, path, banUntil });
      return res.status(403).json({ error: `请求过于频繁，已被临时封禁${Math.round(RATE_LIMIT_CONFIG.BAN_DURATION_MS/60000)}分钟` });
    } else {
      requestStats.banIp.delete(ip);
    }
  }
  // 统计总数
  requestStats.total++;
  // 统计路径
  requestStats.perPath.set(path, (requestStats.perPath.get(path) || 0) + 1);
  // 统计IP
  if (!requestStats.perIp.has(ip)) requestStats.perIp.set(ip, []);
  requestStats.perIp.get(ip).push({ timestamp: now, path });
  // 限速逻辑：限速窗口内超过最大请求数，返回429，超限N次则封禁
  const windowAgo = now - RATE_LIMIT_CONFIG.RATE_LIMIT_WINDOW_MS;
  const recentReqs = requestStats.perIp.get(ip).filter(r => r.timestamp > windowAgo);
  // 用全局Map统计429次数
  if (recentReqs.length > RATE_LIMIT_CONFIG.RATE_LIMIT_MAX) {
    const prev429 = requestStats.rate429Map.get(ip) || 0;
    const curr429 = prev429 + 1;
    requestStats.rate429Map.set(ip, curr429);
    logger.warn('限速触发429', { ip, path, count: recentReqs.length, rate429: curr429 });
    if (curr429 > RATE_LIMIT_CONFIG.RATE_LIMIT_BAN_TIMES) {
      requestStats.banIp.set(ip, now + RATE_LIMIT_CONFIG.BAN_DURATION_MS);
      logger.warn('IP被封禁', { ip, path, banMinutes: Math.round(RATE_LIMIT_CONFIG.BAN_DURATION_MS/60000) });
      requestStats.rate429Map.set(ip, 0); // 封禁后清零
      return res.status(403).json({ error: `请求过于频繁，已被临时封禁${Math.round(RATE_LIMIT_CONFIG.BAN_DURATION_MS/60000)}分钟` });
    }
    return res.status(429).json({ error: `请求过于频繁，请${Math.round(RATE_LIMIT_CONFIG.RATE_LIMIT_WINDOW_MS/1000)}秒后再试` });
  }
  next();
}
app.use(statAndRateLimitV2);
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'webui', 'inweb.html'));
});
app.use(express.static(__dirname));
const ipRecordQueue: any[] = [];
function queueIpRecord(task_id: string, ip: string, info: string) {
  ipRecordQueue.push({ task_id, ip, info, created_at: Date.now() });
}
setInterval(async () => {
  if (!Array.isArray(ipRecordQueue) || ipRecordQueue.length === 0) return;
  const batch = ipRecordQueue.splice(0, ipRecordQueue.length);
  for (const rec of batch) {
    try {
      await addIpRecord(rec.task_id, rec.ip, rec.info, rec.created_at);
    } catch (e) {
      queueDbRetry(addIpRecord, [rec.task_id, rec.ip, rec.info, rec.created_at]);
      logger.warn('addIpRecord失败，已加入重试队列', { task_id: rec.task_id, ip: rec.ip, error: e });
    }
  }
}, 5000);

async function asyncWithRetry<T>(fn: (...args: any[]) => Promise<T>, args: any[], maxRetry = 3): Promise<T> {
  let lastErr;
  for (let i = 0; i < maxRetry; i++) {
    try {
      return await fn(...args);
    } catch (e) {
      lastErr = e;
      if (i < maxRetry - 1) {
        logger.warn('数据库操作失败，重试中', { fn: fn.name, args, retry: i + 1, error: e });
        await new Promise(r => setTimeout(r, 200 * (i + 1)));
      }
    }
  }
  logger.error('数据库操作重试失败，已放弃', { fn: fn.name, args, error: lastErr });
  throw lastErr;
}

async function getTaskDirect(taskId: string) {
  return await asyncWithRetry(getTask, [taskId]);
}
async function getIpRecordsDirect(taskId: string) {
  return await asyncWithRetry(getUniqueIpRecords, [taskId]);
}

async function getIpInfoWithRetry(ip: string) {
  return await asyncWithRetry(getIpInfo, [ip]);
}

// 启动
initDB()
  .then(async () => {
    logger.info('数据库初始化完成', {});
    const server = app.listen(Number(PORT), '0.0.0.0', () => {
      logger.info(`服务已启动: http://localhost:${PORT}`, {});
    });
    server.on('error', (err) => {
      logger.error('服务启动失败', { err });
    });
    setInterval(() => {
      cleanZeroIpTasks();
    }, 60 * 60 * 1000);
    setInterval(async () => {
      try {
        logger.info('开始数据库VACUUM优化', {});
        await vacuumAndAnalyze();
        logger.info('VACUUM+ANALYZE完成', {});
      } catch (e) {
        logger.error('数据库优化失败', { error: e });
      }
    }, 24 * 60 * 60 * 1000);
    schedule.scheduleJob('0 0 * * *', () => {
      const logsDir = path.resolve(process.cwd(), 'logs');
      if (fs.existsSync(logsDir)) {
        const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
        for (const file of files) {
          const filePath = path.join(logsDir, file);
          try {
            fs.truncateSync(filePath, 0);
            logger.info('定时清空日志文件', { file: filePath });
          } catch (e) {
            logger.error('定时清空日志文件失败', { file: filePath, error: e });
          }
        }
      }
    });
  })
  .catch((err) => {
    logger.error('服务启动失败', { err });
  });

function getOperator(token, key) {
  if (token && token === config.ADMIN_TOKEN) return 'admin';
  if (key) return key.slice(0, 4) + '****';
  return 'unknown';
}

// API: /api/page/* 仅记录IP和日志，不做鉴权
app.get('/api/page/*', async (req, res, next) => {
  const taskid = req.path.split('/').pop() || '';
  let task;
  try {
    task = await getTaskDirect(taskid);
  } catch (e) {
    logger.error('获取任务失败', { taskid, error: e });
    return res.status(500).json({ error: '任务查询失败' });
  }
  if (!task) {
    logger.info('任务不存在，图片请求被拒绝', {
      ip: getClientIp(req),
      url: req.originalUrl,
      ua: req.headers['user-agent'],
      time: new Date().toISOString(),
      result: 'fail'
    });
    return res.status(404).json({ error: '任务不存在' });
  }
  // 有效期判断
  if (task.time !== 0) {
    const now = Date.now();
    if (now - task.created_at > task.time * 60 * 1000) {
      logger.info('任务已过期，图片请求被拒绝', {
        ip: getClientIp(req),
        url: req.originalUrl,
        ua: req.headers['user-agent'],
        time: new Date().toISOString(),
        result: 'fail'
      });
      return res.status(403).json({ error: '任务已过期' });
    }
  }
  if (task.status !== 'active') {
    logger.info('任务未激活，图片请求被拒绝', {
      ip: getClientIp(req),
      url: req.originalUrl,
      ua: req.headers['user-agent'],
      time: new Date().toISOString(),
      result: 'fail'
    });
    return res.status(403).json({ error: '任务未激活' });
  }
  // 记录IP
  const ip = getClientIp(req);
  let info = {};
  try { info = await getIpInfoWithRetry(ip); } catch (e) { logger.warn('IP归属查询失败', { ip, error: e }); }
  queueIpRecord(task.id, ip, JSON.stringify(info));
  logger.info('图片请求', {
    ip,
    url: req.originalUrl,
    ua: req.headers['user-agent'],
    task: task.id,
    time: new Date().toISOString(),
    result: 'success'
  });
  // mode=jump
  let mode = '';
  let jumpurl = '';
  try {
    if (typeof task.imgurl === 'string' && task.imgurl.startsWith('{')) {
      const obj = JSON.parse(task.imgurl);
      mode = obj.mode || '';
      jumpurl = obj.jumpurl || '';
    }
  } catch {}
  if (mode === 'jump') {
    if (jumpurl && jumpurl.trim()) {
      return res.redirect(jumpurl);
    } else {
      return res.redirect('https://www.bing.com');
    }
  }
  // 图片优先级：1. 任务imgurl 2. 本地图片 3. 全局api
  let imgurl = '';
  if (task.imgurl && String(task.imgurl).trim()) {
    imgurl = task.imgurl;
  } else if (config.LOCAL_IMAGE_FIRST && fs.existsSync(config.IMAGE_DIR)) {
    const supportedExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.ico'];
    const files = fs.readdirSync(config.IMAGE_DIR).filter(f => supportedExts.includes(path.extname(f).toLowerCase()));
    if (files.length > 0) {
      const file = files[Math.floor(Math.random() * files.length)];
      const imgPath = path.join(config.IMAGE_DIR, file);
      try {
        const img = fs.readFileSync(imgPath);
        const ext = path.extname(file).toLowerCase();
        const mimeMap = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.tiff': 'image/tiff', '.ico': 'image/x-icon'
        };
        const type = mimeMap[ext] || 'application/octet-stream';
        res.set('Content-Type', type);
        return res.send(img);
      } catch (e) {
        logger.error('本地图片读取失败', { imgPath, error: e });
      }
    }
    imgurl = config.IMAGE_URL;
  } else {
    imgurl = config.IMAGE_URL;
  }
  if (req.query.redirect === '1') {
    return res.redirect(imgurl);
  }
  try {
    const imgRes = await fetch(imgurl);
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (e) {
    logger.error('远程图片加载失败', { url: imgurl, error: e });
    res.status(500).send('图片加载失败');
  }
});

// API: /api/getip/:taskid
app.get('/api/getip/:taskid', async (req, res) => {
  const { token, key } = getTokenAndKey(req);
  const operator = getOperator(token, key);
  const geo = typeof req.query.geo === 'string' ? req.query.geo : undefined;
  const ipType = typeof req.query.type === 'string' ? req.query.type : undefined;
  if (token === config.ADMIN_TOKEN) {
  } else if (key) {
    const ok = await consumeApiKey(key);
    if (!ok) {
      logger.warn('Key无效或余额不足，无法获取IP', { operator, authType: 'key', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
      return res.status(403).json({ error: 'Key无效或余额不足' });
    }
  } else {
    logger.warn('无权限获取IP', { operator, authType: 'none', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
    return res.status(401).json({ error: '无权限' });
  }
  const task = await getTaskDirect(req.params.taskid as string);
  if (!task) {
    logger.warn('任务不存在', { operator, ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
    return res.status(404).json({ error: '任务不存在' });
  }
  const records = await getIpRecordsDirect(req.params.taskid as string);
  const ips: any[] = [];
  for (const r of records) {
    // 根据 type 参数过滤 IPv4/IPv6
    if (ipType === '4' && r.ip.includes(':')) continue;
    if (ipType === '6' && !r.ip.includes(':')) continue;
    let apis: any[] = [];
    try {
      apis = JSON.parse(r.info);
      if (!Array.isArray(apis)) apis = [];
    } catch { apis = []; }
    let createdAtStr = '';
    try {
      createdAtStr = new Date(Number(r.created_at)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    } catch { createdAtStr = String(r.created_at); }
    ips.push({
      ip: r.ip,
      apis,
      created_at: createdAtStr
    });
  }
  logger.info('获取任务IP', { operator, authType: token === config.ADMIN_TOKEN ? 'token' : 'key', ip: getClientIp(req), url: req.originalUrl, task: req.params.taskid, count: ips.length, result: 'success' });
  res.json({ ips });
});

// API: /api/server
app.get('/api/server', async (req, res, next) => {
  const { token, key } = getTokenAndKey(req);
  const operator = getOperator(token, key);
  
  // 获取图片URL
  let imgurl = '';
  if (typeof req.query.imgurl === 'string') {
    imgurl = req.query.imgurl;
  } else if (Array.isArray(req.query.imgurl)) {
    imgurl = String(req.query.imgurl[0]);
  } else if (req.query.imgurl) {
    imgurl = String(req.query.imgurl);
  }

  // 获取链接URL
  let url = '';
  if (typeof req.query.url === 'string') {
    url = req.query.url;
  } else if (Array.isArray(req.query.url)) {
    url = String(req.query.url[0]);
  } else if (req.query.url) {
    url = String(req.query.url);
  }

  let time = 10;
  if (typeof req.query.time === 'string') {
    const t = parseInt(req.query.time as string);
    if (!isNaN(t) && t >= 0) time = t;
  } else if (Array.isArray(req.query.time)) {
    const t = parseInt(req.query.time[0] as string);
    if (!isNaN(t) && t >= 0) time = t;
  } else if (req.query.time) {
    const t = parseInt(String(req.query.time));
    if (!isNaN(t) && t >= 0) time = t;
  }

  // 获取自定义数据参数
  const text = typeof req.query.text === 'string' ? req.query.text : '';
  const text1 = typeof req.query.text1 === 'string' ? req.query.text1 : '';
  const data = typeof req.query.data === 'string' ? req.query.data : '';
  const mode = typeof req.query.mode === 'string' ? req.query.mode : '';
  const jumpurl = typeof req.query.jumpurl === 'string' ? req.query.jumpurl : '';

  if (token === config.ADMIN_TOKEN) {
    try {
      const id = genTaskId();
      let imgurlToSave = imgurl;
      if (mode === 'jump') {
        imgurlToSave = JSON.stringify({ mode: 'jump', jumpurl: jumpurl });
      }
      await createTask(id, imgurlToSave, time, '');
      logger.info('新任务开启', { operator, authType: 'token', ip: getClientIp(req), url: req.originalUrl, taskId: id, imgurl: imgurlToSave, time, result: 'success' });
      const protocol = req.protocol;
      const host = req.get('host');
      const recordUrl = `${protocol}://${host}/api/page/${id}`;
      if (data === 'pb') {
        return res.json({
          "1": {
            "1": url || "https://www.bilibili.com/video/BV1UT42167xb/",
            "12": {
              "14": {
                "1": text || "哔哩哔哩(゜-゜)つロ干杯~-bilibili",
                "2": text1 || "【4K珍藏】诈骗神曲《Never Gonna Give You Up》！愿者上钩！\n\n",
                "3": recordUrl
              }
            }
          }
        });
      }
      return res.json({
        taskId: id,
        recordUrl: recordUrl
      });
    } catch (e) {
      logger.error('管理员创建任务失败', { operator, error: e });
      return res.status(500).json({ error: '任务创建失败' });
    }
  }
  if (key) {
    const ok = await consumeApiKey(key);
    if (!ok) {
      logger.warn('Key无效或余额不足，无法开启任务', { operator, authType: 'key', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
      return res.status(403).json({ error: 'Key无效或余额不足' });
    }
    try {
      const id = genTaskId();
      let imgurlToSave = imgurl;
      if (mode === 'jump') {
        imgurlToSave = JSON.stringify({ mode: 'jump', jumpurl: jumpurl });
      }
      await createTask(id, imgurlToSave, time, String(key));
      logger.info('新任务开启', { operator, authType: 'key', ip: getClientIp(req), url: req.originalUrl, taskId: id, imgurl: imgurlToSave, time, result: 'success' });
      const protocol = req.protocol;
      const host = req.get('host');
      const recordUrl = `${protocol}://${host}/api/page/${id}`;
      
      if (data === 'pb') {
        return res.json({
          "1": {
            "1": url || "https://www.bilibili.com/video/BV1UT42167xb/",
            "12": {
              "14": {
                "1": text || "哔哩哔哩(゜-゜)つロ干杯~-bilibili",
                "2": text1 || "【4K珍藏】诈骗神曲《Never Gonna Give You Up》！愿者上钩！\n\n",
                "3": recordUrl
              }
            }
          }
        });
      }
      
      return res.json({
        taskId: id,
        recordUrl: recordUrl
      });
    } catch (e) {
      logger.error('用户创建任务失败', { operator, error: e });
      return res.status(500).json({ error: '任务创建失败' });
    }
  }
  logger.warn('无权限开启任务', { operator, authType: 'none', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
  return res.status(401).json({ error: '无权限' });
});

// API: /api/stop
app.get('/api/stop', async (req, res) => {
  const { token, key } = getTokenAndKey(req);
  const operator = getOperator(token, key);
  let id = '';
  if (typeof req.query.id === 'string') id = req.query.id;
  else if (Array.isArray(req.query.id)) id = typeof req.query.id[0] === 'string' ? req.query.id[0] : '';
  else id = '';
  if (token === config.ADMIN_TOKEN) {
    // 管理员直接通过
  } else if (key) {
    const ok = await consumeApiKey(key);
    if (!ok) {
      logger.warn('Key无效或余额不足，无法暂停任务', { operator, authType: 'key', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
      return res.status(403).json({ error: 'Key无效或余额不足' });
    }
  } else {
    logger.warn('无权限暂停任务', { operator, authType: 'none', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
    return res.status(401).json({ error: '无权限' });
  }
  const task = await getTaskDirect(id);
  if (!task) {
    logger.warn('任务不存在', { operator, ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
    return res.status(404).json({ error: '任务不存在' });
  }
  await stopTask(id);
  logger.info('任务暂停', { operator, authType: token === config.ADMIN_TOKEN ? 'token' : 'key', ip: getClientIp(req), url: req.originalUrl, id, result: 'success' });
  res.json({ success: true });
});

// 列出全部任务及状态
app.get('/api/list', auth, async function(req, res) {
  const operator = getOperator(req.cookies.webui_token, req.query.key);
  let tasks: any[] = [];
  const now = Date.now();
  const key = req.query.key;
  if (operator === 'admin') {
    tasks = await getAllTasks();
  } else if (key && typeof key === 'string') {
    tasks = await getTasksByKey(key);
  } else {
    tasks = [];
  }
  // 先暂停超时任务
  for (const t of tasks) {
    if (t.status === 'active' && now - t.created_at > 10 * 60 * 1000) {
      await stopTask(t.id);
      logger.info('自动暂停超时任务', { operator, taskId: t.id, result: 'auto-stopped' });
    }
  }
  // 再次查询，保证状态和数据库一致
  if (operator === 'admin') {
    tasks = await getAllTasks();
  } else if (key && typeof key === 'string') {
    tasks = await getTasksByKey(key);
  } else {
    tasks = [];
  }
  for (const t of tasks) {
    t.ipCount = await getUniqueIpCount(t.id);
    t.status = t.status === 'active' ? '活跃' : '暂停';
    try {
      t.created_at = new Date(Number(t.created_at)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    } catch {}
  }
  logger.info('任务列表查询', { operator, ip: getClientIp(req), url: req.originalUrl, result: 'success', count: tasks.length });
  res.json({ tasks });
});
// 登录认证中间件
function auth(req, res, next) {
  const token = req.cookies.webui_token || req.headers['x-token'] || req.query.token || req.body?.token;
  const key = req.query.key || req.headers['x-api-key'] || req.body?.key;
  
  if (token === config.ADMIN_TOKEN) {
    return next();
  }
  
  if (key) {
    getApiKey(key).then(apiKey => {
      if (apiKey && apiKey.balance > 0) {
        (req as any).apiKey = apiKey;
        return next();
      } else {
        if (req.accepts('html')) {
          res.status(403);
          return res.redirect('/login');
        }
        return res.status(403).json({ error: '未登录或无权限' });
      }
    });
    return; // 必须return，防止后续代码继续执行
  }

  if (req.accepts('html')) {
    res.status(403);
    return res.redirect('/login');
  }
  return res.status(403).json({ error: '未登录或无权限' });
}

// 登录页
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'webui/webui-login.html'));
});

// 登录接口
app.post('/login', (req, res) => {
  const { token } = req.body;
  if (token === config.ADMIN_TOKEN) {
    const isHttps = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('webui_token', token, {
      httpOnly: false,
      path: '/',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
      ...(isHttps ? { secure: true } : {})
    });
    logger.info('全局登录成功', { operator: 'admin', ip: getClientIp(req), url: req.originalUrl, result: 'success' });
    return res.json({ success: true, redirect: '/webui' });
  }
  logger.warn('全局登录失败', { operator: token, ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
  res.status(401).json({ error: 'token错误' });
});

// 登出接口
app.post('/logout', (req, res) => {
  res.clearCookie('webui_token', { path: '/' });
  logger.info('登出', { operator: 'admin', ip: getClientIp(req), url: req.originalUrl, result: 'success' });
  res.json({ success: true });
});

app.get('/webui', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'webui/webui.html'));
});

// 工具函数
function getTokenAndKey(req) {
  let token = '';
  let key = '';
  if (typeof req.query.token === 'string') token = req.query.token;
  if (typeof req.query.key === 'string') key = req.query.key;
  else if (Array.isArray(req.query.key)) key = req.query.key[0];
  return { token, key };
}
// API: /api/webui/settings（只允许管理员token访问，key无法获取）
app.get('/api/webui/settings', auth, (req, res) => {

  res.json({
    IMAGE_URL: config.IMAGE_URL,
    IMAGE_DIR: config.IMAGE_DIR,
    LOCAL_IMAGE_FIRST: config.LOCAL_IMAGE_FIRST,
    IPINFO_API: config.IPINFO_API,
    DB_TYPE: config.DB_TYPE
  });
});
app.post('/api/webui/settings', auth, (req, res) => {
  const { IMAGE_URL, IMAGE_DIR, LOCAL_IMAGE_FIRST, IPINFO_API, ADMIN_TOKEN } = req.body;
  const newCfg: Partial<typeof config> = {};
  if (IMAGE_URL) newCfg.IMAGE_URL = IMAGE_URL;
  if (IMAGE_DIR) newCfg.IMAGE_DIR = IMAGE_DIR;
  if (typeof LOCAL_IMAGE_FIRST === 'boolean') newCfg.LOCAL_IMAGE_FIRST = LOCAL_IMAGE_FIRST;
  if (IPINFO_API) newCfg.IPINFO_API = IPINFO_API;
  if (ADMIN_TOKEN) newCfg.ADMIN_TOKEN = ADMIN_TOKEN;
  saveConfig(newCfg);
  config = loadConfig();
  logger.info('WebUI设置已更改', { operator: 'admin', ip: getClientIp(req), url: req.originalUrl, newCfg, result: 'success' });
  res.json({ success: true });
});

app.get('/api/webui/logs', auth, (req, res) => {
  const logPath = path.resolve(process.cwd(), 'logs/app.log');
  if (!fs.existsSync(logPath)) return res.json({ logs: '' });
  const logs = fs.readFileSync(logPath, 'utf-8').split('\n');
  const start = parseInt(req.query.start as string) || 0;
  const limit = parseInt(req.query.limit as string) || 200;
  const pageLogs = logs.slice(start, start + limit).join('\n');
  res.json({ logs: pageLogs });
});

app.post('/api/webui/logs/clear', auth, (req, res) => {
  const logPath = path.resolve(process.cwd(), 'logs/app.log');
  fs.writeFileSync(logPath, '', 'utf-8');
  logRequest(req, 'info', '日志已清空');
  res.json({ success: true });
});

app.get('/api/keys/list', auth, async (req, res) => {
  const operator = getOperator(req.cookies.webui_token, req.query.key);
  logger.info('API Key列表查询', { operator, ip: getClientIp(req), url: req.originalUrl, result: 'success' });
  res.json({ keys: await listApiKeys() });
});
app.post('/api/keys/add', auth, async (req, res) => {
  const { api_key, balance } = req.body;
  await createApiKey(api_key, balance);
  logger.info('新增API Key', { operator: 'admin', ip: getClientIp(req), url: req.originalUrl, api_key: api_key.slice(0,4)+'****', balance, result: 'success' });
  res.json({ success: true });
});
app.post('/api/keys/update', auth, async (req, res) => {
  const { api_key, balance } = req.body;
  await updateApiKeyBalance(api_key, balance);
  logger.info('修改API Key余额', { operator: 'admin', ip: getClientIp(req), url: req.originalUrl, api_key: api_key.slice(0,4)+'****', balance, result: 'success' });
  res.json({ success: true });
});
app.post('/api/keys/delete', auth, async (req, res) => {
  const { api_key } = req.body;
  await deleteApiKey(api_key);
  logger.info('删除API Key', { operator: 'admin', ip: getClientIp(req), url: req.originalUrl, api_key: api_key.slice(0,4)+'****', result: 'success' });
  res.json({ success: true });
});

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-token'] || (req.cookies && req.cookies.webui_token);
  (req as any).token = token;
  next();
});

function logRequest(req: any, level: 'info'|'warn'|'error'|'debug', msg: string, meta?: any) {
  const base = {
    ip: getClientIp(req),
    url: req.originalUrl || req.url,
    ua: req.headers['user-agent']
  };
  logger[level](msg, { ...base, ...meta });
}

app.get('/api/webui/rate-limit-config', auth, (req, res) => {
  res.json({ config: RATE_LIMIT_CONFIG });
});
app.post('/api/webui/rate-limit-config', auth, (req, res) => {
  const allowedKeys = Object.keys(RATE_LIMIT_CONFIG);
  let changed = {};
  let hasChange = false;
  for (const k of allowedKeys) {
    if (req.body[k] !== undefined && typeof RATE_LIMIT_CONFIG[k] === 'number') {
      const v = Number(req.body[k]);
      if (!isNaN(v) && v > 0 && v !== RATE_LIMIT_CONFIG[k]) {
        changed[k] = v;
        RATE_LIMIT_CONFIG[k] = v;
        hasChange = true;
      }
    }
  }
  if (hasChange) {
    // 持久化到 config.json
    saveConfig({ ...config, RATE_LIMIT_CONFIG });
    config = loadConfig();
    logger.info('管理员修改限速配置', { operator: 'admin', ip: getClientIp(req), url: req.originalUrl, changed, result: 'success' });
    return res.json({ success: true, msg: '限速参数已保存', config: RATE_LIMIT_CONFIG });
  } else {
    logger.info('限速配置未变更', { operator: 'admin', ip: getClientIp(req), url: req.originalUrl, result: 'nochange' });
    return res.json({ success: false, msg: '未检测到有效变更', config: RATE_LIMIT_CONFIG });
  }
});

// 查询当前被封禁IP列表（WebUI用）
app.get('/api/webui/ban-ip-list', auth, (req, res) => {
  const now = Date.now();
  const list = Array.from(requestStats.banIp.entries())
    .filter(([ip, banUntil]) => now < banUntil)
    .map(([ip, banUntil]) => ({ ip, banUntil }));
  res.json({ list });
});

// 解封指定IP（WebUI用）
app.post('/api/webui/unban-ip', auth, (req, res) => {
  const { ip } = req.body;
  if (ip && requestStats.banIp.has(ip)) {
    requestStats.banIp.delete(ip);
    res.json({ success: true, msg: '已解封' });
  } else {
    res.json({ success: false, msg: 'IP不存在或未被封禁' });
  }
});

// 全局统计对象
const apiStats = {
  total: 0,
  perPath: {},
  perStatus: {},
  perUA: {},
};

// 统计中间件
app.use((req, res, next) => {
  apiStats.total++;
  apiStats.perPath[req.path] = (apiStats.perPath[req.path] || 0) + 1;
  // 记录UA
  const ua = req.headers['user-agent'] || '';
  apiStats.perUA[ua] = (apiStats.perUA[ua] || 0) + 1;
  // 记录状态码
  res.on('finish', () => {
    apiStats.perStatus[res.statusCode] = (apiStats.perStatus[res.statusCode] || 0) + 1;
  });
  next();
});

// 统计API
app.get('/api/statistics', (req, res) => {
  res.json({
    total: apiStats.total,
    perPath: apiStats.perPath,
    perStatus: apiStats.perStatus,
    perUA: apiStats.perUA,
  });
});

async function safeAddIpRecord(...args) {
  for (let i = 0; i < 3; i++) {
    try {
      return await addIpRecord.apply(null, [args[0], args[1], args[2], args[3]]);
    } catch (e) {
      if (i === 2) throw e;
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

app.get('/help', (req, res) => {
  res.sendFile(path.join(__dirname, 'webui/webui-help.html'));
});

app.get('/user/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'webui/webui-user-login.html'));
});

// 检查 API Key 是否有效
app.get('/api/check-key', async (req, res) => {
  const key = req.query.key;
  if (!key || typeof key !== 'string') {
    return res.json({ valid: false, error: 'API Key 不能为空' });
  }
  
  try {
    const apiKey = await getApiKey(key);
    if (!apiKey) {
      return res.json({ valid: false, error: 'API Key 不存在' });
    }
    if (apiKey.balance <= 0) {
      return res.json({ valid: false, error: 'API Key 已过期' });
    }
    return res.json({ valid: true });
  } catch (error) {
    logger.error('检查 API Key 失败', { error });
    return res.status(500).json({ valid: false, error: '服务器错误' });
  }
});

app.get('/user', async (req, res) => {
  const key = req.query.key;
  if (!key || typeof key !== 'string') {
    return res.redirect('/user/login');
  }
  const apiKey = await getApiKey(key);
  if (!apiKey || apiKey.balance <= 0) {
    return res.redirect('/user/login');
  }
  res.sendFile(path.join(__dirname, 'webui/webui-user.html'));
});

app.get('/api/user/tasks', auth, async (req, res) => {
  const apiKey = (req as any).apiKey;
  if (!apiKey) {
    return res.status(403).json({ error: '无权限' });
  }
  let tasks: any[] = await getTasksByKey(apiKey.api_key);
  const now = Date.now();
  // 先暂停所有超时任务
  for (const t of tasks) {
    if (t.status === 'active' && now - t.created_at > 10 * 60 * 1000) {
      await stopTask(t.id);
      logger.info('自动暂停超时任务', { operator: apiKey.api_key.slice(0,4)+'****', taskId: t.id, result: 'auto-stopped' });
    }
  }
  // 再次查询，保证状态和数据库一致
  tasks = await getTasksByKey(apiKey.api_key);
  for (const t of tasks) {
    t.ipCount = await getUniqueIpCount(t.id);
    t.status = t.status === 'active' ? '活跃' : '暂停';
    try {
      t.created_at = new Date(Number(t.created_at)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    } catch {}
  }
  logger.info('任务列表查询', { operator: apiKey.api_key.slice(0,4)+'****', ip: getClientIp(req), url: req.originalUrl, result: 'success', count: tasks.length });
  res.json({ tasks });
});

app.get('/api/user/getip/:taskid', auth, async (req, res) => {
  const apiKey = (req as any).apiKey;
  if (!apiKey) {
    return res.status(403).json({ error: '无权限' });
  }
  const task = await getTaskDirect(req.params.taskid as string);
  if (!task || task.key !== apiKey.api_key) {
    logger.warn('任务不存在', { operator: apiKey.api_key.slice(0,4)+'****', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
    return res.status(404).json({ error: '任务不存在' });
  }
  const records = await getIpRecordsDirect(req.params.taskid as string);
  const ips: any[] = [];
  for (const r of records) {
    let apis: any[] = [];
    try {
      apis = JSON.parse(r.info);
      if (!Array.isArray(apis)) apis = [];
    } catch { apis = []; }
    let createdAtStr = '';
    try {
      createdAtStr = new Date(Number(r.created_at)).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    } catch { createdAtStr = String(r.created_at); }
    ips.push({
      ip: r.ip,
      apis,
      created_at: createdAtStr
    });
  }
  logger.info('获取任务IP', { operator: apiKey.api_key.slice(0,4)+'****', ip: getClientIp(req), url: req.originalUrl, task: req.params.taskid, count: ips.length, result: 'success' });
  res.json({ ips });
});

app.get('/api/user/stop', auth, async (req, res) => {
  const apiKey = (req as any).apiKey;
  if (!apiKey) {
    return res.status(403).json({ error: '无权限' });
  }
  let id = '';
  if (typeof req.query.id === 'string') id = req.query.id;
  else if (Array.isArray(req.query.id)) id = typeof req.query.id[0] === 'string' ? req.query.id[0] : '';
  else id = '';
  const task = await getTaskDirect(id);
  if (!task || task.key !== apiKey.api_key) {
    logger.warn('任务不存在', { operator: apiKey.api_key.slice(0,4)+'****', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
    return res.status(404).json({ error: '任务不存在' });
  }
  await stopTask(id);
  logger.info('任务暂停', { operator: apiKey.api_key.slice(0,4)+'****', ip: getClientIp(req), url: req.originalUrl, id, result: 'success' });
  res.json({ success: true });
});

app.get('/api/user/server', auth, async (req, res) => {
  const apiKey = (req as any).apiKey;
  if (!apiKey) {
    return res.status(403).json({ error: '无权限' });
  }
  
  // 获取图片URL
  let imgurl = '';
  if (typeof req.query.imgurl === 'string') {
    imgurl = req.query.imgurl;
  } else if (Array.isArray(req.query.imgurl)) {
    imgurl = String(req.query.imgurl[0]);
  } else if (req.query.imgurl) {
    imgurl = String(req.query.imgurl);
  }

  // 获取链接URL
  let url = '';
  if (typeof req.query.url === 'string') {
    url = req.query.url;
  } else if (Array.isArray(req.query.url)) {
    url = String(req.query.url[0]);
  } else if (req.query.url) {
    url = String(req.query.url);
  }

  let time = 10;
  if (typeof req.query.time === 'string') {
    const t = parseInt(req.query.time as string);
    if (!isNaN(t) && t >= 0) time = t;
  } else if (Array.isArray(req.query.time)) {
    const t = parseInt(req.query.time[0] as string);
    if (!isNaN(t) && t >= 0) time = t;
  } else if (req.query.time) {
    const t = parseInt(String(req.query.time));
    if (!isNaN(t) && t >= 0) time = t;
  }

  // 获取自定义数据参数
  const text = typeof req.query.text === 'string' ? req.query.text : '';
  const text1 = typeof req.query.text1 === 'string' ? req.query.text1 : '';
  const data = typeof req.query.data === 'string' ? req.query.data : '';

  const ok = await consumeApiKey(apiKey.api_key);
  if (!ok) {
    logger.warn('Key余额不足，无法开启任务', { operator: apiKey.api_key.slice(0,4)+'****', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
    return res.status(403).json({ error: 'Key余额不足' });
  }

  const id = genTaskId();
  await createTask(id, imgurl, time, String(apiKey.api_key));
  logger.info('新任务开启', { operator: apiKey.api_key.slice(0,4)+'****', ip: getClientIp(req), url: req.originalUrl, taskId: id, imgurl, time, result: 'success' });
  const protocol = req.protocol;
  const host = req.get('host');
  const recordUrl = `${protocol}://${host}/api/page/${id}`;
  
  if (data === 'pb') {
    return res.json({
      "1": {
        "1": url || "https://www.bilibili.com/video/BV1UT42167xb/",
        "12": {
          "14": {
            "1": text || "哔哩哔哩(゜-゜)つロ干杯~-bilibili",
            "2": text1 || "【4K珍藏】诈骗神曲《Never Gonna Give You Up》！愿者上钩！\n\n",
            "3": recordUrl
          }
        }
      }
    });
  }
  
  return res.json({
    taskId: id,
    recordUrl: recordUrl
  });
});

// 用户解绑任务
app.get('/api/user/unbind-task', auth, async (req, res) => {
  const apiKey = (req as any).apiKey;
  if (!apiKey) {
    return res.status(403).json({ error: '无权限' });
  }
  let id = '';
  if (typeof req.query.id === 'string') id = req.query.id;
  else if (Array.isArray(req.query.id)) id = typeof req.query.id[0] === 'string' ? req.query.id[0] : '';
  else id = '';
  const task = await getTaskDirect(id);
  if (!task || task.key !== apiKey.api_key) {
    logger.warn('任务不存在或无权限解绑', { operator: apiKey.api_key.slice(0,4)+'****', ip: getClientIp(req), url: req.originalUrl, result: 'fail' });
    return res.status(404).json({ error: '任务不存在' });
  }
  // 解绑
  await updateTaskKey(id, '');
  logger.info('用户解绑任务', { operator: apiKey.api_key.slice(0,4)+'****', ip: getClientIp(req), url: req.originalUrl, id, result: 'success' });
  res.json({ success: true });
});
app.get('/jump', (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';
  if (!url || !/^https?:\/\//i.test(url)) {
    logger.warn('跳转失败，url无效', { ip, url, ua });
    return res.status(400).send('无效的跳转地址');
  }
  logger.info('跳转请求', { ip, url, ua });
  // 统计功能已由全局中间件自动记录
  return res.redirect(url);
});

// ========== 新增：数据库操作失败自动重试队列 ===========
interface RetryTask {
  fn: (...args: any[]) => Promise<any>;
  args: any[];
  retryCount: number;
}
const dbRetryQueue: RetryTask[] = [];
const MAX_RETRY = 3;
const RETRY_INTERVAL = 5000; // 5秒重试一次

function queueDbRetry(fn: (...args: any[]) => Promise<any>, args: any[], retryCount = 0) {
  dbRetryQueue.push({ fn, args, retryCount });
}

setInterval(async () => {
  if (dbRetryQueue.length === 0) return;
  const tasks = dbRetryQueue.splice(0, dbRetryQueue.length);
  for (const task of tasks) {
    try {
      await task.fn(...task.args);
    } catch (e) {
      if (task.retryCount < MAX_RETRY) {
        queueDbRetry(task.fn, task.args, task.retryCount + 1);
      } else {
        logger.error('数据库重试失败，已放弃', { fn: task.fn.name, args: task.args, error: e });
      }
    }
  }
}, RETRY_INTERVAL);
