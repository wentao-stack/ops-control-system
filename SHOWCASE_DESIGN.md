# 公共展示墙设计文档

## 1. 项目概述
公共展示墙是一个无需登录的公开页面，仅展示已审批通过的内容。支持多类型媒体展示，包含动画视频、博客文章、图片画廊、文档资料等。

## 2. 功能需求

### 2.1 访问控制
- 无需登录即可访问
- 仅展示 `status = 'approved'` 的内容
- 内容审批流程由后台管理员执行

### 2.2 内容类型
- animation: 动画视频
- blog: 博客文章
- image: 图片画廊
- document: 文档资料

### 2.3 筛选功能
- 按分类筛选
- 按标签筛选
- 按内容类型筛选
- 搜索功能

### 2.4 多语言支持
- zh-TW (默认)
- en (英语)
- ja (日语)

## 3. 技术架构

### 3.1 前端
- React + TypeScript
- 页面组件: `ShowcasePage.tsx`
- 路由: `/showcase`
- i18n 支持

### 3.2 后端
- FastAPI
- SQLAlchemy ORM
- SQLite 数据库
- API 端点: `/api/v1/showcase`

### 3.3 数据库
- 表名: `showcase_items`
- 字段: id, title, description, content_type, category, tags, media_url, thumbnail_url, status, language, author, created_at, approved_at, approved_by

## 4. 页面设计

### 4.1 布局
- 顶部导航栏：Logo + 分类筛选 + 语言切换
- 主区域：卡片网格展示
- 页脚：版权信息

### 4.2 卡片设计
- 封面图/缩略图
- 标题
- 描述摘要
- 类型标签
- 分类标签
- 上传时间

## 5. API 接口

### GET /api/v1/showcase
查询已审批内容列表
参数:
- category: 分类
- tag: 标签
- content_type: 内容类型
- language: 语言

返回:
```json
{
  "items": [
    {
      "id": "uuid",
      "title": "标题",
      "description": "描述",
      "content_type": "animation",
      "category": "category",
      "tags": ["tag1", "tag2"],
      "media_url": "url",
      "thumbnail_url": "url",
      "created_at": "2024-01-01T00:00:00Z",
      "approved_at": "2024-01-02T00:00:00Z"
    }
  ]
}
```

## 6. 开发进度
见 SHOWCASE_PLAN.md

## 7. 部署说明
- 前端构建产物部署到 `frontend/dist`
- 后端 API 通过 FRP 暴露
- 数据库迁移通过 SQLAlchemy 自动创建
