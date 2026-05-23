'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function Nav() {
  const pathname = usePathname()

  const isActive = (href: string) => pathname === href

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-5 h-14 border-b"
      style={{
        background: 'oklch(10% 0.01 240 / 0.88)',
        backdropFilter: 'blur(14px)',
        borderColor: 'var(--color-border-subtle)',
      }}
    >
      {/* Logo */}
      <Link href="/" className="flex items-center gap-2 flex-shrink-0">
        <span className="text-base font-black tracking-tight" style={{ color: 'var(--color-text)' }}>
          chiaro
        </span>
        <span className="text-xs px-1.5 py-0.5 rounded font-semibold"
          style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}>
          beta
        </span>
      </Link>

      {/* Tab switcher */}
      <nav
        className="flex items-center gap-0.5 p-0.5 rounded-full"
        style={{ background: 'var(--color-surface)' }}
      >
        {[
          { href: '/', label: 'Discover' },
          { href: '/dashboard', label: 'Applications' },
          { href: '/inbox', label: 'Inbox' },
        ].map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className="px-3.5 py-1.5 rounded-full text-sm font-medium transition-all"
            style={{
              color: isActive(href) ? 'var(--color-text)' : 'var(--color-text-muted)',
              background: isActive(href) ? 'var(--color-surface-elevated)' : 'transparent',
            }}
          >
            {label}
          </Link>
        ))}
      </nav>

      {/* Profile avatar */}
      <Link
        href="/profile"
        aria-label="Profile"
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all flex-shrink-0"
        style={{
          background: isActive('/profile') ? 'var(--color-accent)' : 'var(--color-surface-elevated)',
          color: isActive('/profile') ? 'white' : 'var(--color-text-secondary)',
          border: '1px solid var(--color-border-subtle)',
        }}
      >
        P
      </Link>
    </header>
  )
}
