// Server-only Google OAuth2 client builder for the Gmail inbox connection.
// Tokens are persisted encrypted (AES-256-CBC via sessionManager helpers).
import 'server-only'
import { google } from 'googleapis'
import type { OAuth2Client, Credentials } from 'google-auth-library'
import { prisma } from '../db'
import { encrypt, decrypt } from '../sessionManager'

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`[gmail/oauthClient] Missing required env var: ${name}`)
  return v
}

export function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    requireEnv('GOOGLE_WEB_CLIENT_ID'),
    requireEnv('GOOGLE_WEB_CLIENT_SECRET'),
    requireEnv('GOOGLE_REDIRECT_URI'),
  )
}

export function getAuthUrl(oauthClient: OAuth2Client): string {
  return oauthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...GMAIL_SCOPES],
  })
}

export interface ExchangeResult {
  oauthClient: OAuth2Client
  tokens: Credentials
}

export async function exchangeCodeForTokens(code: string): Promise<ExchangeResult> {
  const oauthClient = createOAuthClient()
  const { tokens } = await oauthClient.getToken(code)
  oauthClient.setCredentials(tokens)
  return { oauthClient, tokens }
}

// Builds an OAuth client from a stored GmailConnection row and wires an
// auto-refresh hook so rotated tokens get persisted.
export async function getRefreshedClient(userId: string): Promise<OAuth2Client | null> {
  const conn = await prisma.gmailConnection.findUnique({ where: { userId } })
  if (!conn || !conn.isActive) return null

  let accessToken: string
  let refreshToken: string
  try {
    accessToken = decrypt(conn.accessToken)
    refreshToken = decrypt(conn.refreshToken)
  } catch (err) {
    console.warn('[gmail/oauthClient] Token decrypt failed — connection unusable:', err instanceof Error ? err.message : String(err))
    return null
  }

  const oauthClient = createOAuthClient()
  oauthClient.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: conn.tokenExpiry.getTime(),
  })

  oauthClient.on('tokens', (newTokens) => {
    const updates: { accessToken?: string; refreshToken?: string; tokenExpiry?: Date } = {}
    if (newTokens.access_token) updates.accessToken = encrypt(newTokens.access_token)
    if (newTokens.refresh_token) updates.refreshToken = encrypt(newTokens.refresh_token)
    if (newTokens.expiry_date) updates.tokenExpiry = new Date(newTokens.expiry_date)

    if (Object.keys(updates).length === 0) return
    void prisma.gmailConnection
      .update({ where: { userId }, data: updates })
      .catch((err: unknown) => {
        console.warn('[gmail/oauthClient] Failed to persist refreshed tokens:', err instanceof Error ? err.message : String(err))
      })
  })

  return oauthClient
}

// Persist tokens after the OAuth callback. Encrypts access/refresh tokens
// using the project's ENCRYPTION_KEY (same key as Wellfound session cookies).
export async function saveConnection(params: {
  userId: string
  gmailAddress: string
  tokens: Credentials
}): Promise<void> {
  const { userId, gmailAddress, tokens } = params
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('[gmail/oauthClient] OAuth response missing access_token or refresh_token')
  }
  const expiry = tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000)

  await prisma.gmailConnection.upsert({
    where: { userId },
    create: {
      userId,
      gmailAddress,
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(tokens.refresh_token),
      tokenExpiry: expiry,
      isActive: true,
    },
    update: {
      gmailAddress,
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(tokens.refresh_token),
      tokenExpiry: expiry,
      isActive: true,
      connectedAt: new Date(),
    },
  })
}
