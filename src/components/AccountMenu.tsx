import { useEffect, useRef, useState } from 'react'
import { useEscape, type Account } from '@minormending/map-kit'
import { auth } from '../lib/db'
import { locate } from '../lib/locate'
import { readStart, saveStart, clearStart } from '../lib/start'
import { submissionState, type Submission, type SubmissionState } from '../lib/submissions'
import { orchardUrl } from '../lib/orchards'
import type { Origin } from '../lib/travel'

/**
 * Who you are, what you proposed, and where you set off from.
 *
 * Signing in used to buy a name in the corner and a sign-out link. Everything
 * it actually unlocked was invisible: a person could add a farm and never hear
 * what happened to it, and the control that makes this map answer a question —
 * travelling from — had to be redone from scratch on every visit.
 *
 * So the three things that are genuinely about *you* live behind one button:
 * the farms you proposed and their state, a starting point that is remembered,
 * and the way out.
 */
export function AccountMenu({
  account,
  base,
  submissions,
  loading,
  origin,
  onOrigin,
  mineOnly,
  onMineOnly,
}: {
  account: Account
  /** The site's base path, for linking a published submission to its page. */
  base: string
  submissions: Submission[]
  loading: SubmissionState
  origin: Origin | null
  onOrigin: (at: Origin) => void
  mineOnly: boolean
  onMineOnly: (on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<Origin | null>(() => readStart())
  const [address, setAddress] = useState('')
  const [looking, setLooking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /*
   * What the lookup found, waiting to be accepted.
   *
   * It is not applied until somebody says so, and that is not politeness. One
   * box holding a whole address gives Photon no town to anchor on, and the
   * `near` bias then answers with whatever is closest to the Hudson Valley:
   * "350 Hudson St, New York" came back as a veterinary clinic on Hudson
   * Street in Cornwall, forty miles north, with four decimal places and no
   * hint that anything was wrong. Saved silently, that is every drive time on
   * the map quietly measured from the wrong place — which is the one failure
   * this project is built around.
   *
   * So the geocoder proposes and the person disposes, exactly as it does in
   * `AddOrchard`. The full label is shown, United States and all, because the
   * long version is what makes a wrong answer obvious.
   */
  const [found, setFound] = useState<Origin | null>(null)
  /* Google's avatar host answers 404 often enough — a deleted photo, a
     rotated URL — that a broken image icon next to somebody's name is a real
     outcome rather than a hypothetical. */
  const [avatarOk, setAvatarOk] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  useEscape(() => setOpen(false))

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const onMap = submissions.filter((s) => s.status === 'active')

  const lookUp = async () => {
    if (address.trim().length < 4) return
    setLooking(true)
    setProblem(null)
    setFound(null)
    try {
      const result = await locate({ address, town: '' })
      if (!result.ok) {
        setProblem(result.reason)
        return
      }
      setFound({ ...result.at, label: result.label })
    } catch {
      setProblem('Address lookup is unavailable just now.')
    } finally {
      setLooking(false)
    }
  }

  const accept = () => {
    if (!found) return
    saveStart(found)
    setSaved(found)
    onOrigin(found)
    setFound(null)
    setAddress('')
  }

  const keepCurrent = () => {
    if (!origin) return
    saveStart(origin)
    setSaved(origin)
  }

  const forget = () => {
    clearStart()
    setSaved(null)
  }

  const initial = account.name.trim().charAt(0).toUpperCase() || '?'

  return (
    <div className="account" ref={box}>
      <button
        type="button"
        className="account-button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        {account.avatar && avatarOk ? (
          <img
            className="account-avatar"
            src={account.avatar}
            alt=""
            width={24}
            height={24}
            referrerPolicy="no-referrer"
            onError={() => setAvatarOk(false)}
          />
        ) : (
          <span className="account-avatar account-initial" aria-hidden="true">{initial}</span>
        )}
        <span className="account-name">{account.name}</span>
      </button>

      {open && (
        <div className="account-menu" role="menu">
          <section className="account-block">
            <h3>Farms you added</h3>
            {loading === 'loading' && <p className="muted">Looking…</p>}
            {loading === 'failed' && (
              <p className="muted">Could not load those just now.</p>
            )}
            {loading === 'ready' && submissions.length === 0 && (
              <p className="muted">None yet. Anything you add shows up here.</p>
            )}
            {submissions.length > 0 && (
              <ul className="account-subs">
                {submissions.map((s) => (
                  <li key={s.slug}>
                    {s.status === 'active' ? (
                      <a href={orchardUrl(base, s.slug)}>{s.name}</a>
                    ) : (
                      <span>{s.name}</span>
                    )}
                    <span className={`account-status account-${s.status}`}>
                      {submissionState(s.status)}
                    </span>
                    {/*
                      * The date, because the status cannot say more than it
                      * knows. `hidden` is both "waiting" and "decided against"
                      * and the client has no way to tell them apart — see the
                      * note in lib/submissions.ts. How long it has been is the
                      * fact somebody needs to judge whether to ask.
                      */}
                    {s.status !== 'active' && (
                      <span className="muted">
                        {' '}added {new Date(s.created_at).toLocaleDateString()}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {onMap.length > 0 && (
              <label className="account-check">
                <input
                  type="checkbox"
                  checked={mineOnly}
                  onChange={(e) => onMineOnly(e.target.checked)}
                />
                <span>
                  Show only yours on the map
                  {/* Only the published ones can be shown, because the map is
                      built from the published file. Saying which number this
                      is stops the filter looking broken to somebody whose
                      other proposal is still waiting. */}
                  {onMap.length < submissions.length && (
                    <em className="muted">
                      {' '}— {onMap.length} of {submissions.length}{' '}
                      {onMap.length === 1 ? 'is' : 'are'} on it
                    </em>
                  )}
                </span>
              </label>
            )}
          </section>

          <section className="account-block">
            <h3>Starting point</h3>
            {saved ? (
              <p className="account-saved">
                <span className="origin-dot" aria-hidden="true" />
                {saved.label}
                <button type="button" className="link" onClick={forget}>forget</button>
              </p>
            ) : (
              <p className="muted">
                Kept in this browser only, so drive times are there when you
                come back.
              </p>
            )}

            <div className="account-address">
              <input
                value={address}
                onChange={(e) => { setAddress(e.target.value); setFound(null) }}
                placeholder="Where do you set off from?"
                maxLength={200}
                autoComplete="off"
                onKeyDown={(e) => { if (e.key === 'Enter') lookUp() }}
              />
              <button
                type="button"
                className="button"
                disabled={looking || address.trim().length < 4}
                onClick={lookUp}
              >
                {looking ? 'Looking…' : 'Find'}
              </button>
            </div>
            {problem && <p className="auth-error">{problem}</p>}

            {found && (
              <p className="account-found" aria-live="polite">
                That address is <strong>{found.label}</strong>.{' '}
                <button type="button" className="link" onClick={accept}>
                  Keep it
                </button>
                {' · '}
                <button type="button" className="link" onClick={() => setFound(null)}>
                  not that
                </button>
              </p>
            )}

            {origin && origin.label !== saved?.label && (
              <button type="button" className="link" onClick={keepCurrent}>
                Keep “{origin.label}” instead
              </button>
            )}
          </section>

          <section className="account-block">
            <button type="button" className="link" onClick={() => auth.signOut()}>
              Sign out
            </button>
          </section>
        </div>
      )}
    </div>
  )
}
