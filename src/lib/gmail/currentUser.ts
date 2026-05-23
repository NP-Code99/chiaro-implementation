// Single-user app: every Gmail route resolves the "current" user via the same
// shortcut the rest of the codebase uses (prisma.user.findFirst). Centralized
// here so we can swap in a real auth layer in one place.
import 'server-only'
import { prisma } from '../db'

export async function getCurrentUserId(): Promise<string | null> {
  const u = await prisma.user.findFirst({ select: { id: true } })
  return u?.id ?? null
}
