import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Carnet',
    short_name: 'Carnet',
    description: 'Language learning with spaced repetition',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f9f7f4',
    theme_color: '#f9f7f4',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
