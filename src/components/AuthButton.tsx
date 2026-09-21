import { useState } from 'react'
import { auth, HAS_DB } from '../lib/db'
import { useAccount } from '../lib/account'

/**
 * The way in, and only the way in.
 *
 * Signing in buys exactly two things: adding an orchard, and answering a
 * question about one. Reading the map and reporting what you found need no
 * account, and the copy says so — a sign-in button with no stated purpose
 * reads as a data grab.
 *
 * What it looks like once you ARE signed in lives in `AccountMenu`, which
 * needs the submissions the map is already loading and would otherwise fetch
 * them twice.
 */
export function AuthButton() {
  const account = useAccount()
  const [error, setError] = useState<string | null>(null)

  if (!HAS_DB || account) return null

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
