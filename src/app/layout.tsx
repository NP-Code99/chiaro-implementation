import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { Nav } from '@/components/ui/Nav'
import { Toaster } from 'react-hot-toast'
import '@/styles/globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Chiaro — Auto-Apply to Startup Jobs',
  description: 'Swipe right to automatically apply to top startup jobs. Let Chiaro handle the forms.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Nav />
        <main className="pt-14 min-h-screen" style={{ background: 'var(--color-bg)' }}>
          {children}
        </main>
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: {
              background: 'var(--color-surface-elevated)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 'var(--radius-lg)',
              fontSize: '0.875rem',
            },
          }}
        />
      </body>
    </html>
  )
}
