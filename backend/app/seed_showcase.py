from datetime import datetime, timezone
from app.database import SessionLocal
from app.models import ShowcaseItem
import uuid

session = SessionLocal()

items = [
    {
        "id": str(uuid.uuid4()),
        "title": "AI 动画演示",
        "description": "使用 ComfyUI 生成的动画作品展示",
        "content_type": "animation",
        "category": "AI Art",
        "tags": "AI,动画,ComfyUI",
        "media_url": "https://example.com/demo1.mp4",
        "thumbnail_url": "https://example.com/thumb1.jpg",
        "status": "approved",
        "language": "zh-TW",
        "author": "演示用户",
        "created_at": datetime.now(timezone.utc),
        "approved_at": datetime.now(timezone.utc),
        "approved_by": "admin"
    },
    {
        "id": str(uuid.uuid4()),
        "title": "技术博客：OPS 系统架构",
        "description": "OPS 控制系统的技术架构介绍",
        "content_type": "blog",
        "category": "技术文档",
        "tags": "架构,FastAPI,React",
        "media_url": "https://example.com/blog1.html",
        "thumbnail_url": "https://example.com/blog1.jpg",
        "status": "approved",
        "language": "zh-TW",
        "author": "技术团队",
        "created_at": datetime.now(timezone.utc),
        "approved_at": datetime.now(timezone.utc),
        "approved_by": "admin"
    },
    {
        "id": str(uuid.uuid4()),
        "title": "产品图片集",
        "description": "产品展示图片集合",
        "content_type": "image",
        "category": "产品",
        "tags": "产品,图片,展示",
        "media_url": "https://example.com/gallery1",
        "thumbnail_url": "https://example.com/gallery1_thumb.jpg",
        "status": "approved",
        "language": "zh-TW",
        "author": "设计团队",
        "created_at": datetime.now(timezone.utc),
        "approved_at": datetime.now(timezone.utc),
        "approved_by": "admin"
    },
    {
        "id": str(uuid.uuid4()),
        "title": "API 文档",
        "description": "OPS 控制系统 API 文档",
        "content_type": "document",
        "category": "文档",
        "tags": "API,文档,参考",
        "media_url": "https://example.com/api-docs.pdf",
        "thumbnail_url": "https://example.com/api-docs.jpg",
        "status": "approved",
        "language": "zh-TW",
        "author": "开发团队",
        "created_at": datetime.now(timezone.utc),
        "approved_at": datetime.now(timezone.utc),
        "approved_by": "admin"
    },
]

for item_data in items:
    item = ShowcaseItem(**item_data)
    session.add(item)

session.commit()
print(f"已创建 {len(items)} 条示例数据")
session.close()
