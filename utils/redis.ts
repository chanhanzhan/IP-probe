import Redis from 'ioredis';
import { logger } from './logger';

const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  // password: '', // 如有密码请填写
});

redis.on('connect', () => logger.info('Redis 连接成功', {}));
redis.on('error', (err: Error) => logger.error('Redis 连接错误', { error: err.message }));

export default redis; 