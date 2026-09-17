import { useState } from 'react'
import { useEscape } from '@minormending/map-kit'
import { supabase, HAS_DB } from '../lib/db'
import { useAccount } from '../lib/account'
import { FILTERS } from '../lib/filters'
import type { Tag } from '../lib/types'

/**
 * Propose an orchard that is not here.
 *
 * It lands hidden and goes to the moderation queue. A signed-in stranger
 * cannot put a pin on the map — which is the same door an auto-hidden orchard
 * comes back through, so there is one review path rather than two.
 *
 * The position comes from a click on the map rather than a typed address,
 * because several of these farms are down an unnamed track and geocoding their
 * address lands you at the wrong end of the county.
 */
export function AddOrchard({
  at,
  onPick,
  onClose,
}: {
  at: { lat: number; lng: number } | null
  onPick: () => void
  onClose: () => void
}) {
  const account = useAccount()
  const [name, setName] = useState('')
  const [town, setTown] = useState('')
  const [address, setAddress] = useState('')
  const [tags, setTags] = useState<Tag[]>([])
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [problem, setProblem] = useState<string | null>(null)

  useEscape(onClose)

  if (!HAS_DB) return null

  const send = async () => {
    if (!at || name.trim().length < 2) return
    setState('sending')
    setProblem(null)

    const { data, error } = await supabase!.rpc('submit_orchard', {
      p_name: name,
      p_lat: at.lat,
      p_lng: at.lng,
      p_address: address || null,
      p_town: town || null,
      p_state: 'NY',
      p_tags: tags,
    })

    if (error) {
      setState('idle')
      setProblem(
        error.code === '53400'
          ? 'That is five for today — thank you, come back tomorrow.'
          : 'That did not go through. Try again shortly.',
      )
      return
    }
    if (data && data.ok === false) {
      setState('idle')
      setProblem(
        data.reason === 'duplicate'
          ? `There is already a pin within 300m — ${data.near}. Is it the same farm?`
          : 'That could not be added.',
      )
      return
    }
    setState('sent')
  }

  return (
    <section className="add" aria-label="Add an orchard">
      <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">×</button>
      <h2>Add an orchard</h2>

      {!account ? (
        <p className="muted">
          Adding a farm needs an account, so there is somebody to ask if a
          listing turns out to be wrong. Reporting what you found does not.
        </p>
      ) : state === 'sent' ? (
        <p className="flag-sent">
          Thank you. It goes to a person before it appears on the map — usually
          within a day or two.
        </p>
      ) : (
        <>
          <label className="add-field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </label>
          <label className="add-field">
            <span>Town</span>
            <input value={town} onChange={(e) => setTown(e.target.value)} maxLength={100} />
          </label>
          <label className="add-field">
            <span>Address</span>
            <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
          </label>

          <p className="add-where">
            {at ? (
              <>Position set: {at.lat.toFixed(4)}, {at.lng.toFixed(4)}. </>
            ) : (
              <>No position yet. </>
            )}
            <button type="button" className="link" onClick={onPick}>
              {at ? 'Pick again on the map' : 'Click the map to place it'}
            </button>
          </p>

          <div className="chips">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`chip ${tags.includes(f.key) ? 'chip-on' : ''}`}
                aria-pressed={tags.includes(f.key)}
                onClick={() =>
                  setTags((t) =>
                    t.includes(f.key) ? t.filter((x) => x !== f.key) : [...t, f.key],
                  )
                }
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flag-actions">
            <button
              type="button"
              className="button"
              disabled={!at || name.trim().length < 2 || state === 'sending'}
              onClick={send}
            >
              {state === 'sending' ? 'Sending…' : 'Submit for review'}
            </button>
          </div>
          {problem && <p className="auth-error">{problem}</p>}
        </>
      )}
    </section>
  )
}
