# API 文档

## 目录

- [通用说明](#通用说明)
- [错误码与返回结构说明](#错误码与返回结构说明)
- [用户相关接口](#用户相关接口)
- [管理员相关接口](#管理员相关接口)
- [统计与日志](#统计与日志)
- [跳转与辅助](#跳转与辅助)

---

## 通用说明

- 所有接口均为 RESTful 风格，返回 JSON。
- 除特殊说明外，所有接口均支持 GET 请求。
- 鉴权方式：部分接口需 `token`（管理员）或 `key`（用户）参数，支持 query、header、body 传递。
- 返回格式示例：

  ```json
  {
    "success": true,
    "data": { }
  }
  ```

- 错误返回示例：

  ```json
  {
    "success": false,
    "error": "错误信息"
  }
  ```

- 时间戳均为北京时间（东八区），格式为字符串。

---

## 错误码与返回结构说明

### 1. HTTP状态码说明

本项目所有API均严格遵循标准HTTP状态码，常见状态码及含义如下：

| 状态码 | 含义                       | 典型场景                         |
|:------:|:--------------------------|:----------------------------------|
| 200    | OK                        | 请求成功，返回数据                |
| 201    | Created                   | 创建资源成功                      |
| 204    | No Content                | 操作成功，无返回内容              |
| 302    | Found                     | 跳转（如 /jump、mode=jump 任务）  |
| 400    | Bad Request               | 参数错误、请求格式不合法          |
| 401    | Unauthorized              | 未认证，token/key无效或缺失       |
| 403    | Forbidden                 | 无权限，账号被封禁等              |
| 404    | Not Found                 | 资源不存在                        |
| 405    | Method Not Allowed        | 请求方法不被允许                  |
| 429    | Too Many Requests         | 触发限流                          |
| 500    | Internal Server Error     | 服务器内部错误                    |

详细HTTP状态码可参考：[REST API HTTP Status Codes](https://restfulapi.net/http-status-codes/)

### 2. 字段释义

| 字段    | 类型    | 说明                   |
|:--------|:--------|:----------------------|
| success | boolean | 是否成功，true/false   |
| code    | int     | 业务错误码，0为成功    |
| message | string  | 结果说明/错误描述      |
| data    | object  | 主要返回数据内容       |
| error   | string  | 错误信息（失败时）     |
| status  | int     | HTTP状态码（部分接口） |

一般推荐前端判断 `success` 字段，或 `code==0` 代表成功。

`data` 字段为主要业务数据，结构因接口而异。

`error` 或 `message` 字段为错误描述，便于调试和用户提示。

### 3. 状态和返回解析

判断成功：

- HTTP状态码为200/201/204等，且 `success: true` 或 `code: 0`

判断失败：

- HTTP状态码为4xx/5xx，或 `success: false` 或 `code!=0`

常见返回结构：

成功：

```json
{
  "success": true,
  "code": 0,
  "message": "操作成功",
  "data": { }
}
```

失败：

```json

{
  "success": false,
  "code": 10001,
  "message": "参数缺失: key",
  "error": "参数校验失败"
}
```

某些接口如重定向（302）、静态资源等，直接返回HTTP状态码和内容。

建议调用方优先判断 `status`（HTTP状态码）和 `success` 或 `code` 字段，再结合 `error/message` 字段做处理。

---

## 用户相关接口

### 1. 用户 WebUI 登录

`GET /user/login`

- 说明：返回用户登录页面（HTML）。
- 示例：

  ```http

  GET /user/login
  ```

- 返回：HTML 页面

### 2. 用户 WebUI 主页面

`GET /user?key=xxx`

- 说明：需传入有效 `key`，否则跳转到登录页。
- 参数：
  - `key` (string, 必填) 用户API Key
- 示例：

  ```http

  GET /user?key=1234567890abcdef
  ```
- 返回：HTML 页面

### 3. 用户任务列表
`GET /api/user/tasks?key=xxx`

- 说明：返回当前 key 下所有任务。
- 参数：
  - `key` (string, 必填) 用户API Key
- 示例：

  ```http
  GET /api/user/tasks?key=1234567890abcdef
  ```

- 返回：

  ```json
  {
    "tasks": [
      {
        "id": "w1qc7z9dmafs1zvr",
        "imgurl": "https://img.example.com/1.jpg",
        "time": 10,
        "status": "活跃",
        "ipCount": 2,
        "created_at": "2025-05-08 19:45:48"
      }
    ]
  }
  ```

### 4. 用户创建任务

`GET /api/user/server?key=xxx&imgurl=...&time=...&mode=jump&jumpurl=...`

- 说明：创建新任务，支持 `mode=jump` 跳转模式。
- 参数：
  - `key` (string, 必填) 用户API Key
  - `imgurl` (string, 可选) 图片URL
  - `time` (int, 可选) 任务有效期，单位分钟，默认10
  - `mode` (string, 可选) 任务模式，支持 `jump` 跳转
  - `jumpurl` (string, 可选) 跳转目标URL，配合 `mode=jump` 使用
- 示例：

  ```http
  GET /api/user/server?key=1234567890abcdef&mode=jump&jumpurl=https://www.baidu.com
  ```

- 返回：

  ```json
  {
    "taskId": "w1qc7z9dmafs1zvr",
    "recordUrl": "http://localhost:3000/api/page/w1qc7z9dmafs1zvr"
  }
  ```

### 5. 用户获取任务IP

`GET /api/user/getip/:taskid?key=xxx`

- 说明：返回该任务下所有IP记录。
- 参数：
  - `taskid` (string, 必填) 任务ID
  - `key` (string, 必填) 用户API Key
- 示例：

  ```http
  GET /api/user/getip/w1qc7z9dmafs1zvr?key=1234567890abcdef

  ```

- 返回：

  ```json
  {
    "ips": [
      {
        "ip": "127.0.0.1",
        "apis": [],
        "created_at": "2025-05-08 19:45:53"
      }
    ]
  }
  ```

### 6. 用户停止任务

`GET /api/user/stop?id=xxx&key=xxx`

- 说明：停止指定任务。

- 参数：
  - `id` (string, 必填) 任务ID
  - `key` (string, 必填) 用户API Key
- 示例：

  ```http

  GET /api/user/stop?id=w1qc7z9dmafs1zvr&key=1234567890abcdef

  ```

- 返回：

  ```json
  { "success": true }
  ```

### 7. 用户解绑任务

`GET /api/user/unbind-task?id=xxx&key=xxx`

- 说明：解绑（软删除）指定任务。

- 参数：
  - `id` (string, 必填) 任务ID
  - `key` (string, 必填) 用户API Key
- 示例：

  ```http

  GET /api/user/unbind-task?id=w1qc7z9dmafs1zvr&key=1234567890abcdef

  ```

- 返回：

  ```json
  { "success": true }
  ```

---

## 管理员相关接口

### 1. 管理员登录

`POST /login`

- 说明：管理员登录，获取全局管理权限。

- 参数：
  - `token` (string, 必填) 管理员Token
- 示例：

  ```http

  POST /login
  Content-Type: application/json
  {
    "token": "your_admin_token"
  }
  ```

- 返回：

  ```json

  { "success": true, "redirect": "/webui" }
  ```

### 2. 管理员 WebUI 主页面

`GET /webui?token=xxx`

- 说明：需管理员 token。
- 示例：

  ```http
  GET /webui?token=your_admin_token
  ```

- 返回：HTML 页面

### 3. 管理员任务列表

`GET /api/list?token=xxx`
- 说明：返回所有任务。
- 示例：
  ```http
  GET /api/list?token=your_admin_token
  ```
- 返回：同用户任务列表

### 4. 管理员创建任务
`GET /api/server?token=xxx&imgurl=...&time=...&mode=jump&jumpurl=...`
- 说明：参数同用户接口，支持 `mode=jump` 跳转模式。
- 示例：
  ```http
  GET /api/server?token=your_admin_token&mode=jump&jumpurl=https://www.baidu.com
  ```
- 返回：同用户创建任务

### 5. 管理员获取任务IP
`GET /api/getip/:taskid?token=xxx`
- 说明：返回该任务下所有IP记录。
- 示例：
  ```http
  GET /api/getip/w1qc7z9dmafs1zvr?token=your_admin_token
  ```
- 返回：同用户获取任务IP

### 6. 管理员停止任务
`GET /api/stop?id=xxx&token=xxx`
- 说明：停止指定任务。
- 示例：
  ```http
  GET /api/stop?id=w1qc7z9dmafs1zvr&token=your_admin_token
  ```
- 返回：
  ```json
  { "success": true }
  ```

### 7. 管理员 API Key 管理
- `GET /api/keys/list?token=xxx`：列出所有API Key
- `POST /api/keys/add`：新增API Key（参数：`api_key`, `balance`）
- `POST /api/keys/update`：修改API Key余额
- `POST /api/keys/delete`：删除API Key
- 示例：
  ```http
  POST /api/keys/add
  Content-Type: application/json
  {
    "api_key": "newkey123",
    "balance": 100
  }
  ```
- 返回：
  ```json
  { "success": true }
  ```

### 8. 管理员限速配置
- `GET /api/webui/rate-limit-config?token=xxx`：获取限速配置
- `POST /api/webui/rate-limit-config`：修改限速配置
- 示例：
  ```http
  POST /api/webui/rate-limit-config
  Content-Type: application/json
  {
    "RATE_LIMIT_MAX": 20
  }
  ```
- 返回：
  ```json
  { "success": true, "msg": "限速参数已保存", "config": { ... } }
  ```

### 9. 管理员日志管理
- `GET /api/webui/logs?token=xxx`：查看日志
- `POST /api/webui/logs/clear?token=xxx`：清空日志
- 返回：
  ```json
  { "success": true }
  ```

### 10. 管理员封禁IP管理
- `GET /api/webui/ban-ip-list?token=xxx`：查询被封禁IP
- `POST /api/webui/unban-ip?token=xxx`：解封指定IP
- 示例：
  ```http
  POST /api/webui/unban-ip
  Content-Type: application/json
  {
    "ip": "127.0.0.1"
  }
  ```
- 返回：
  ```json
  { "success": true, "msg": "已解封" }
  ```

---

## 统计与日志

### 1. 全局统计
`GET /api/statistics`
- 说明：返回所有API的访问统计、UA统计、状态码统计等。
- 示例：
  ```http
  GET /api/statistics
  ```
- 返回：
  ```json
  {
    "total": 123,
    "perPath": { "/api/user/tasks": 10, ... },
    "perStatus": { "200": 120, "404": 3 },
    "perUA": { "Mozilla/5.0 ...": 100, ... }
  }
  ```

---

## 跳转与辅助

### 1. 跳转API


`GET /jump?url=https://xxx.com`

- 说明：无需鉴权，自动 302 跳转到指定 url。

- 参数：
  - `url` (string, 必填) 跳转目标，需 http/https 开头
- 示例：

  ```http

  GET /jump?url=https://www.baidu.com
  ```

- 返回：302 跳转

### 2. 帮助页面

`GET /help`

- 说明：返回帮助文档页面。

- 示例：
  ```http


  GET /help
  ```

- 返回：HTML 页面

### 3. 图片/任务记录API

`GET /api/page/:taskid`
- 说明：记录IP、UA等信息。若任务为 `mode=jump`，则自动重定向到 jumpurl 或 bing.com。
- 参数：
  - `taskid` (string, 必填) 任务ID
- 示例：
  ```http
  GET /api/page/w1qc7z9dmafs1zvr
  ```
- 返回：图片或 302 跳转

---

## 其它说明
- 所有接口均有全局日志和统计，便于追踪和分析。
- 数据库操作均有自动重试机制，保证高可用。
- 详细参数和返回字段请参考实际接口返回。

---
