import { useEffect, useState } from "react"
import { api } from "../auth"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

interface ShowcaseItem {
  id: string
  title: string
  description: string
  content_type: "animation" | "blog" | "image" | "document"
  category: string
  tags: string[]
  media_url: string
  thumbnail_url?: string
  created_at: string
  approved_at: string
  language: string
}

export function ShowcasePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [items, setItems] = useState<ShowcaseItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCategory, setSelectedCategory] = useState("")
  const [selectedTag, setSelectedTag] = useState("")
  
  const categories = [
    { value: "animation", label: t("showcase.category.animation") },
    { value: "blog", label: t("showcase.category.blog") },
    { value: "image", label: t("showcase.category.image") },
    { value: "document", label: t("showcase.category.document") },
  ]

  const load = async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      if (selectedCategory) p.set("category", selectedCategory)
      if (selectedTag) p.set("tag", selectedTag)
      const r = await api<{ items: ShowcaseItem[] }>(`/api/v1/showcase?${p}`)
      setItems(r.items)
    } catch { /* silent */ } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [selectedCategory, selectedTag])

  return (
    <>
      <div className="page-header">
        <div><h1>{t("showcase.title")}</h1><p>{t("showcase.subtitle")}</p></div>
      </div>

      <div className="filters">
        <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}>
          <option value="">{t("showcase.allCategories")}</option>
          <option value="animation">{t("showcase.category.animation")}</option>
          <option value="blog">{t("showcase.category.blog")}</option>
          <option value="image">{t("showcase.category.image")}</option>
          <option value="document">{t("showcase.category.document")}</option>
        </select>
        <input className="search-input" placeholder={t("showcase.searchPlaceholder")} />
      </div>

      <div className="showcase-grid">
        {loading ? (
          <div className="empty">{t("common.loading")}</div>
        ) : items.length === 0 ? (
          <div className="empty">{t("showcase.empty")}</div>
        ) : items.map(item => (
          <div key={item.id} className="showcase-card" onClick={() => navigate(`/showcase/${item.id}`)}>
            <img src={item.thumbnail_url || item.media_url} alt={item.title} />
            <div className="showcase-card-content">
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <div className="showcase-tags">
                <span className="tag">{item.content_type}</span>
                <span className="tag">{item.category}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
