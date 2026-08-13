# 公共展示墙开发计划

## 项目概述
创建无需登录的公共展示页面，仅展示已审批通过的内容，支持多类型媒体（动画/博客/图片/文档），按分类标签筛选，支持多语言。

## 开发进度

### 2026-08-12
- [x] 创建 ShowcasePage.tsx 前端展示页面
  - 创建时间: 2026-08-12
  - 文件路径: frontend/src/pages/ShowcasePage.tsx
  - 功能: 无需登录访问，仅展示已审批内容，支持分类筛选、多类型内容展示
- [x] 创建 Showcase API 后端接口设计
  - 创建时间: 2026-08-12
  - API 路径: /api/v1/showcase
  - 支持查询参数: category, tag, content_type
- [x] 创建数据库模型
  - 创建时间: 2026-08-12
  - 文件路径: backend/app/models.py
  - 模型: ShowcaseItem (id, title, description, content_type, category, tags, media_url, thumbnail_url, status, language, author, created_at, approved_at, approved_by)
- [x] 创建设计文档
  - 创建时间: 2026-08-12
  - 文件路径: SHOWCASE_DESIGN.md
  - 内容: 功能需求、技术架构、API 接口、页面设计
- [x] 集成 i18n 多语言支持
  - 创建时间: 2026-08-12
  - 文件路径: frontend/src/i18n/locales/zh-TW.json, en.json, ja.json
  - 新增: showcase 词典，包含 title/subtitle/category/searchPlaceholder/empty
- [x] TypeScript 检查与构建验证
  - 创建时间: 2026-08-12
  - 检查结果: npx tsc --noEmit 通过
  - 构建结果: npm run build 成功，生成 frontend/dist
- [x] 实现后端 Showcase API
  - 创建时间: 2026-08-12
  - 文件路径: backend/app/main.py
  - 接口: GET /api/v1/showcase, GET /api/v1/showcase/{item_id}
  - 功能: 公共访问，仅返回已审批内容，支持分类/标签筛选
- [x] 集成前端路由
  - 创建时间: 2026-08-12
  - 文件路径: frontend/src/main.tsx
  - 路由: /showcase -> ShowcasePage
- [x] 构建部署
  - 创建时间: 2026-08-12
  - TypeScript 检查: 通过
  - npm build: 成功
  - 前端服务重启: 完成
- [x] 添加示例数据
  - 创建时间: 2026-08-12
  - 文件路径: backend/app/seed_showcase.py
  - 数据: 4 条示例 (动画、博客、图片、文档)
  - 状态: 已初始化到数据库

## 技术栈
- 前端: React + TypeScript + Vite
- 后端: FastAPI + SQLAlchemy + SQLite
- i18n: i18next + react-i18next
- 部署: FRP + Supervisor

## API 设计
- GET /api/v1/showcase/ - 获取已审批内容列表
- GET /api/v1/showcase/{id} - 获取单个内容详情
- GET /api/v1/showcase/categories - 获取分类列表
- GET /api/v1/showcase/tags - 获取标签列表

## 数据模型
- ShowcaseItem
  - id, title, description, content_type, category, tags
  - media_url, thumbnail_url
  - status (pending/approved/rejected)
  - created_at, approved_at
  - language, author
