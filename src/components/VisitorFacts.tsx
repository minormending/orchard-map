import { useState } from 'react'
import { supabase, HAS_DB } from '../lib/db'
import { useAccount } from '../lib/account'
import type { Orchard } from '../lib/types'

/** The fields nobody publishes, so the only way to know is to have been. */
const FIELDS = [
  { key: 'dogs', label: 'Dogs allowed' },
  { key: 'restrooms', label: 'Restrooms' },
  { key: 'wheelchair_rows', label: 'Rows passable with a wheelchair or pushchair' },
  { key: 'cards_accepted', label: 'Takes cards' },
  { key: 'picnic_area', label: 'Somewhere to sit and eat' },
  { key: 'hayride', label: 'Hayride' },
  { key: 'corn_maze', label: 'Corn maze' },
  { key: 'petting_zoo', label: 'Animals to see' },
  { key: 'food_on_site', label: 'Food on site' },
  { key: 'cider_donuts', label: 'Cider donuts made here' },
] as const

type FieldKey = (typeof FIELDS)[number]['key']

/**
 * What is at this farm, answered by people who went.
 *
 * The rule, unchanged from restroom-map: **two people who independently give
 * the same answer settle a field. One person is an account, not a fact.**
 *
 * The cold start is hard on purpose. The first person to say there are cider
 * donuts sees their answer sit unconfirmed until somebody else goes. That is
 * the rule working, not a bug — and it is why the panel shows how thin the
 * evidence is rather than hiding it.
 *
 * Deliberately absent from this list: opening hours and whether picking is
 * open. The farm publishes those. Making two strangers agree about something
 * the operator has already stated in public would leave the field empty for no
 * reason at all.
 */
export function VisitorFacts({ orchard }: { orchard: Orchard }) {
  const account = useAccount()
  const [sent, setSent] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  if (!HAS_DB) return null

  const answer = async (field: FieldKey, value: boolean) => {
    setBusy(field)
    const { data, error } = await supabase!.rpc('submit_visitor_claim', {
      p_orchard_id: orchard.id,
      p_field: field,
      p_value: value,
    })
    setBusy(null)

    if (error) {
      setNote(
        error.code === '53400'
          ? 'That is a lot of answers — try again later.'
          : 'That did not go through.',
      )
      return
    }
    if (data && data.ok === false && data.reason === 'already_settled') {
      setNote('Somebody already settled that one.')
      return
    }
    setSent((s) => ({ ...s, [field]: true }))
    setNote('Recorded. It shows as fact once a second person agrees.')
  }

  if (!account) {
    return (
      <p className="facts-signin">
        Been here? <strong>Sign in</strong> to say what is at this farm — dogs,
        restrooms, cider donuts. Two people who agree settle an answer.
      </p>
    )
  }

  return (
    <div className="facts-claim">
      <p className="facts-q">What is at this farm?</p>
      <ul className="facts-list">
        {FIELDS.map((f) => {
          // `undefined` and `null` both mean nobody has said, and neither is
          // ever rendered as "no".
          const known = orchard[f.key as keyof Orchard] as boolean | null | undefined
          if (known === true || known === false) {
            return (
              <li key={f.key} className="facts-known">
                <span>{f.label}</span>
                <strong>{known ? 'Yes' : 'No'}</strong>
              </li>
            )
          }
          return (
            <li key={f.key}>
              <span>{f.label}</span>
              {sent[f.key] ? (
                <em className="facts-thanks">recorded</em>
              ) : (
                <span className="facts-buttons">
                  <button
                    type="button"
                    className="chip"
                    disabled={busy !== null}
                    onClick={() => answer(f.key, true)}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    className="chip"
                    disabled={busy !== null}
                    onClick={() => answer(f.key, false)}
                  >
                    No
                  </button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {note && <p className="facts-note">{note}</p>}
    </div>
  )
}
