import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: 'https://tinbase.dev', lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: 'https://tinbase.dev/docs', lastModified: new Date(), changeFrequency: 'weekly', priority: 0.8 },
  ]
}
