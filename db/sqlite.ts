import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { logger } from '../utils/logger';

let db: Database;

// 数据库版本控制
const DB_VERSION = 2;

// 迁移脚本
const migrations = [
  // 版本1: 初始表结构
  `
  DROP TABLE IF EXISTS tasks;
  DROP TABLE IF EXISTS ip_records;
  DROP TABLE IF EXISTS api_keys;
  DROP TABLE IF EXISTS db_version;
  
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    status TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    time INTEGER,
    key TEXT,
    imgurl TEXT
  );
  
  CREATE TABLE ip_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    ip TEXT,
    info TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  
  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT UNIQUE,
    balance INTEGER,
    created_at INTEGER
  );
  
  CREATE TABLE db_version (
    version INTEGER PRIMARY KEY
  );
  `,
  // 版本2: 添加 imgurl 列（如果不存在）
  `
  PRAGMA foreign_keys=off;
  BEGIN TRANSACTION;
  
  -- 检查 imgurl 列是否存在
  SELECT CASE 
    WHEN NOT EXISTS(SELECT 1 FROM pragma_table_info('tasks') WHERE name='imgurl') 
    THEN 'ALTER TABLE tasks ADD COLUMN imgurl TEXT;'
    ELSE 'SELECT 1;'
  END;
  
  COMMIT;
  PRAGMA foreign_keys=on;
  `
];

export async function initDB() {
  try {
    db = await open({
      filename: './iplist.db',
      driver: sqlite3.Database
    });

    // 检查数据库是否损坏
    try {
      await db.get('SELECT 1 FROM tasks LIMIT 1');
    } catch (e) {
      logger.warn('数据库可能已损坏，尝试重建', { error: e });
      // 如果表不存在或损坏，执行完整的重建
      await db.exec(migrations[0]);
      await db.run('INSERT INTO db_version (version) VALUES (?)', [DB_VERSION]);
      logger.info('数据库重建完成', { version: DB_VERSION });
      return;
    }

    // 获取当前版本
    let currentVersion = 0;
    try {
      const versionRow = await db.get('SELECT version FROM db_version');
      currentVersion = versionRow ? versionRow.version : 0;
    } catch (e) {
      logger.warn('无法获取数据库版本，尝试重建', { error: e });
      // 如果版本表不存在，执行完整的重建
      await db.exec(migrations[0]);
      await db.run('INSERT INTO db_version (version) VALUES (?)', [DB_VERSION]);
      logger.info('数据库重建完成', { version: DB_VERSION });
      return;
    }

    // 执行迁移
    if (currentVersion < DB_VERSION) {
      logger.info('开始数据库迁移', { from: currentVersion, to: DB_VERSION });
      
      // 开启事务
      await db.exec('BEGIN TRANSACTION');
      
      try {
        // 执行所有未执行的迁移脚本
        for (let v = currentVersion + 1; v <= DB_VERSION; v++) {
          logger.info(`执行迁移脚本 v${v}`, { version: v });
          await db.exec(migrations[v - 1]);
        }
        
        // 更新版本号
        if (currentVersion === 0) {
          await db.run('INSERT INTO db_version (version) VALUES (?)', [DB_VERSION]);
        } else {
          await db.run('UPDATE db_version SET version = ?', [DB_VERSION]);
        }
        
        // 提交事务
        await db.exec('COMMIT');
        logger.info('数据库迁移完成', { version: DB_VERSION });
      } catch (error) {
        // 回滚事务
        await db.exec('ROLLBACK');
        logger.error('数据库迁移失败，尝试重建', { error });
        // 如果迁移失败，执行完整的重建
        await db.exec(migrations[0]);
        await db.run('INSERT INTO db_version (version) VALUES (?)', [DB_VERSION]);
        logger.info('数据库重建完成', { version: DB_VERSION });
      }
    }
  } catch (error) {
    logger.error('数据库初始化失败', { error });
    throw error;
  }
}

export async function createTask(id: string, imgurl: string = '', time: number = 10, key: string = '') {
  const now = Date.now();
  await db.run('INSERT INTO tasks (id, status, created_at, updated_at, imgurl, time, key) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, 'active', now, now, imgurl, time, key]);
}

export async function stopTask(id: string) {
  await db.run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', ['stopped', Date.now(), id]);
}

export async function getTask(id: string) {
  return db.get('SELECT * FROM tasks WHERE id = ?', [id]);
}

export async function getActiveTask() {
  return db.get('SELECT * FROM tasks WHERE status = ? AND created_at > ?', ['active', Date.now() - 10 * 60 * 1000]);
}

export async function addIpRecord(task_id: string, ip: string, info: string, created_at?: number) {
  const exists = await db.get('SELECT 1 FROM ip_records WHERE task_id = ? AND ip = ?', [task_id, ip]);
  if (!exists) {
    const now = created_at || Date.now();
    await db.run('INSERT INTO ip_records (task_id, ip, info, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [task_id, ip, info, now, now]);
  }
}

export async function getIpRecords(task_id: string) {
  return db.all('SELECT * FROM ip_records WHERE task_id = ?', [task_id]);
}

export async function getUniqueIpRecords(task_id: string) {
  // 只返回每个ip的首次记录
  return db.all('SELECT * FROM ip_records WHERE task_id = ? GROUP BY ip ORDER BY created_at ASC', [task_id]);
}

export async function getAllTasks() {
  return db.all('SELECT id, status, created_at, imgurl, time, key FROM tasks ORDER BY created_at DESC');
}

export async function getUniqueIpCount(task_id: string) {
  const row = await db.get('SELECT COUNT(DISTINCT ip) as cnt FROM ip_records WHERE task_id = ?', [task_id]);
  return row?.cnt || 0;
}

export async function createApiKey(api_key: string, balance: number) {
  await db.run('INSERT INTO api_keys (api_key, balance, created_at) VALUES (?, ?, ?)', [api_key, balance, Date.now()]);
}

export async function updateApiKeyBalance(api_key: string, balance: number) {
  await db.run('UPDATE api_keys SET balance = ? WHERE api_key = ?', [balance, api_key]);
}

export async function deleteApiKey(api_key: string) {
  await db.run('DELETE FROM api_keys WHERE api_key = ?', [api_key]);
}

export async function getApiKey(api_key: string) {
  return db.get('SELECT * FROM api_keys WHERE api_key = ?', [api_key]);
}

export async function listApiKeys() {
  return db.all('SELECT api_key, balance, created_at FROM api_keys');
}

export async function consumeApiKey(api_key: string) {
  const key = await getApiKey(api_key);
  if (!key || key.balance <= 0) return false;
  await db.run('UPDATE api_keys SET balance = balance - 1 WHERE api_key = ?', [api_key]);
  return true;
}

export async function cleanZeroIpTasks(timeoutMs: number = 60 * 60 * 1000) {
  // 删除所有已暂停且无IP记录，且结束时间超过timeoutMs的任务
  const now = Date.now();
  const tasks = await db.all('SELECT id, created_at FROM tasks WHERE status = ? ', ['stopped']);
  for (const t of tasks) {
    const ipCount = await db.get('SELECT COUNT(*) as cnt FROM ip_records WHERE task_id = ?', [t.id]);
    if ((ipCount?.cnt || 0) === 0 && now - t.created_at > timeoutMs) {
      await db.run('DELETE FROM tasks WHERE id = ?', [t.id]);
    }
  }
}

export async function getTaskLastUpdateTime(task_id: string) {
  const row = await db.get('SELECT updated_at FROM tasks WHERE id = ?', [task_id]);
  return row?.updated_at || 0;
}

export async function getIpRecordsLastUpdateTime(task_id: string) {
  const row = await db.get('SELECT MAX(updated_at) as last FROM ip_records WHERE task_id = ?', [task_id]);
  return row?.last || 0;
}

export async function getTasksByKey(key: string) {
  return db.all('SELECT id, status, created_at, imgurl, time, key FROM tasks WHERE key = ? ORDER BY created_at DESC', [key]);
}

export async function updateTaskKey(id: string, key: string) {
  await db.run('UPDATE tasks SET key = ? WHERE id = ?', [key, id]);
}

// 导出vacuumAndAnalyze函数，供main.ts定时数据库优化调用
export async function vacuumAndAnalyze() {
  if (!db) throw new Error('数据库未初始化');
  await db.exec('VACUUM;');
  await db.exec('ANALYZE;');
} 