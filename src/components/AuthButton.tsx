import { useState } from 'react'
import { auth, HAS_DB } from '../lib/db'
import { useAccount } from '../lib/account'

/**
 * Signing in buys exactly two things: adding an orchard, and answering a
 * question about one. Reading the map and reporting what you found need no
 * account, and the copy says so — a sign-in button with no stated purpose
 * reads as a data grab.
 */
export function AuthButton() {
  const account = useAccount()
  const [error, setError] = useState<string | null>(null)

  if (!HAS_DB) return null

  if (account) {
    return (
      <div className="auth">
        <span className="auth-who">{account.name}</span>
        <button type="button" className="link" onClick={() => auth.signOut()}>
          Sign out
        </button>
      </div>
    )
  }

  return (
    <div className="auth">
      <button
        type="button"
        className="link"
        onClick={() => auth.signInWithGoogle().catch((e) => setError(e.message))}
      >
        Sign in to add or correct a farm
      </button>
      {error && <p className="auth-error">{error}</p>}
    </div>
  )
}
